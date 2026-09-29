import { config } from "./config.js";
import { supabase } from "./supabaseClient.js";
import { executarCompra, executarCompraAprovada } from "./comprador.js";
import type { PedidoRow } from "./types.js";

const CAMPOS_PEDIDO =
  "id, produto_nome, produto_url_oficial, quantidade, valor_pago, cliente_nome, cliente_cpf, " +
  "cliente_telefone, cep, rua, numero, complemento, bairro, cidade, estado, automacao_status, automacao_tentativas";

const MAX_TENTATIVAS = 3;

// Por enquanto o robô só sabe comprar na Loja Santuário Nacional (VTEX).
// Pedidos de outras lojas (ex: desatadoradosnosoficial.com.br, WooCommerce)
// ficam de fora da automação e continuam no fluxo manual do painel /admin.
const DOMINIO_SUPORTADO = "lojasantuarionacional.com.br";

async function buscarProximoPedido(): Promise<PedidoRow | null> {
  const { data, error } = await supabase
    .from("pedidos")
    .select(CAMPOS_PEDIDO)
    .eq("status", "pago")
    .in("automacao_status", ["pendente", "aprovado"])
    .lt("automacao_tentativas", MAX_TENTATIVAS)
    .like("produto_url_oficial", `%${DOMINIO_SUPORTADO}%`)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Erro ao buscar pedidos:", error.message);
    return null;
  }
  return data as PedidoRow | null;
}

async function marcarProcessando(id: string) {
  await supabase.from("pedidos").update({ automacao_status: "processando" }).eq("id", id);
}

async function salvarScreenshot(pedidoId: string, screenshot: Buffer): Promise<string | null> {
  if (screenshot.length === 0) return null;
  const path = `${pedidoId}/${Date.now()}.png`;
  const { error } = await supabase.storage
    .from("automacao-screenshots")
    .upload(path, screenshot, { contentType: "image/png" });
  if (error) {
    console.error("Erro ao subir screenshot:", error.message);
    return null;
  }
  return path;
}

async function processarPedido(pedido: PedidoRow) {
  console.log(`[${pedido.id}] iniciando compra automática (tentativa ${pedido.automacao_tentativas + 1})`);
  await marcarProcessando(pedido.id);

  const jaAprovado = pedido.automacao_status === "aprovado";
  const resultado = jaAprovado ? await executarCompraAprovada(pedido) : await executarCompra(pedido);

  const screenshotPath = await salvarScreenshot(pedido.id, resultado.screenshot);

  if (!resultado.sucesso) {
    console.error(`[${pedido.id}] falhou:`, resultado.erro);
    await supabase
      .from("pedidos")
      .update({
        automacao_status: "falhou",
        automacao_erro: resultado.erro ?? "Erro desconhecido",
        automacao_screenshot_path: screenshotPath,
        automacao_tentativas: pedido.automacao_tentativas + 1,
        automacao_atualizado_em: new Date().toISOString(),
      })
      .eq("id", pedido.id);
    return;
  }

  if (resultado.precisaAprovacao) {
    console.log(`[${pedido.id}] carrinho pronto, aguardando aprovação no painel`);
    await supabase
      .from("pedidos")
      .update({
        automacao_status: "aguardando_aprovacao",
        automacao_screenshot_path: screenshotPath,
        automacao_erro: null,
        automacao_atualizado_em: new Date().toISOString(),
      })
      .eq("id", pedido.id);
    return;
  }

  console.log(`[${pedido.id}] compra concluída — pedido loja: ${resultado.numeroPedidoLoja ?? "não identificado"}`);
  await supabase
    .from("pedidos")
    .update({
      status: "comprado_na_loja",
      automacao_status: "comprado",
      numero_pedido_loja_oficial: resultado.numeroPedidoLoja ?? null,
      automacao_screenshot_path: screenshotPath,
      automacao_erro: null,
      automacao_atualizado_em: new Date().toISOString(),
    })
    .eq("id", pedido.id);
}

async function loop() {
  console.log(`Worker de compra automática iniciado — modo: ${config.compraModo}`);
  while (true) {
    try {
      const pedido = await buscarProximoPedido();
      if (pedido) {
        await processarPedido(pedido);
        continue; // verifica na hora se tem mais um na fila, sem esperar o intervalo
      }
    } catch (err) {
      console.error("Erro no loop principal:", err);
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}

loop();
