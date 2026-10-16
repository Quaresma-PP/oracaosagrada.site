// Fila assistida: roda no computador do usuário (atalho "Comprar pedidos" na
// Área de Trabalho). Mostra os pedidos pagos que ainda não foram comprados,
// pede confirmação e compra um por um com o navegador na tela. Quando a loja
// pede o reCAPTCHA, toca um aviso e espera a pessoa marcar — o robô nunca
// interage com o captcha.
//
// Não rodar ao mesmo tempo que o worker do Railway: os dois pegariam o
// mesmo pedido.
import { exec } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { supabase } from "./supabaseClient.js";
import { CAMPOS_PEDIDO, DOMINIO_SUPORTADO, MAX_TENTATIVAS, processarPedido } from "./processar.js";
import type { PedidoRow } from "./types.js";

const ESPERA_CAPTCHA_MS = 3 * 60 * 1000;

function bipe() {
  process.stdout.write("\x07");
  if (process.platform === "win32") {
    exec('powershell -NoProfile -Command "[console]::beep(880,300);[console]::beep(880,300);[console]::beep(1100,500)"');
  }
}

function brl(valor: number) {
  return `R$ ${valor.toFixed(2).replace(".", ",")}`;
}

async function buscarFila(): Promise<PedidoRow[]> {
  const { data, error } = await supabase
    .from("pedidos")
    .select(CAMPOS_PEDIDO)
    .eq("status", "pago")
    .in("automacao_status", ["pendente", "aprovado", "aguardando_aprovacao"])
    .lt("automacao_tentativas", MAX_TENTATIVAS)
    .like("produto_url_oficial", `%${DOMINIO_SUPORTADO}%`)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Erro ao buscar pedidos: ${error.message}`);
  return (data ?? []) as unknown as PedidoRow[];
}

async function main() {
  const fila = await buscarFila();
  if (fila.length === 0) {
    console.log("\nNenhum pedido esperando compra. Tudo em dia!\n");
    return;
  }

  console.log(`\n${fila.length} pedido(s) esperando compra na loja do Santuário:\n`);
  fila.forEach((p, i) => {
    const destino = [p.cidade, p.estado].filter(Boolean).join("/") || `CEP ${p.cep ?? "?"}`;
    console.log(
      `  ${i + 1}. ${p.produto_nome} (x${p.quantidade}) — cliente pagou ${brl(Number(p.valor_pago))} — ` +
        `${p.cliente_nome} — ${destino}`
    );
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const resposta = (await rl.question(`\nComprar esses ${fila.length} pedido(s) agora? (s/n) `)).trim().toLowerCase();
  rl.close();
  if (resposta !== "s" && resposta !== "sim") {
    console.log("Nada foi comprado.");
    return;
  }

  const resumo: string[] = [];
  for (const [i, pedido] of fila.entries()) {
    const legenda = `Pedido ${i + 1} de ${fila.length} — ${pedido.produto_nome} para ${pedido.cidade ?? "?"}/${pedido.estado ?? "?"}`;
    console.log(`\n▶ ${legenda}`);
    const resultado = await processarPedido(pedido, {
      legenda,
      esperaMaximaMs: ESPERA_CAPTCHA_MS,
      aoPedirAtencao: (mensagem) => {
        bipe();
        console.log(`\n🔔 ${mensagem}\n   (você tem 3 minutos; se não marcar, o pedido volta pra fila sem cobrança)`);
      },
    });

    if (resultado.sucesso && !resultado.precisaAprovacao) {
      resumo.push(`✅ ${pedido.produto_nome} — pedido na loja: ${resultado.numeroPedidoLoja ?? "não identificado"}`);
    } else if (resultado.podeTentarDeNovo) {
      resumo.push(`⏸️  ${pedido.produto_nome} — captcha não marcado, voltou pra fila (sem cobrança)`);
    } else {
      resumo.push(`❌ ${pedido.produto_nome} — ${resultado.erro ?? "precisa de aprovação"}`);
    }
  }

  console.log("\n===== Resumo =====");
  resumo.forEach((linha) => console.log(linha));
  console.log("");
}

main().catch((err) => {
  console.error("Erro:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
