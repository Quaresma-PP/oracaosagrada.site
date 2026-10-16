import { supabase } from "./supabaseClient.js";
import { executarCompra, executarCompraAprovada, type OpcoesAssistido, type ResultadoCompra } from "./comprador.js";
import type { PedidoRow } from "./types.js";

export const CAMPOS_PEDIDO =
  "id, produto_nome, produto_url_oficial, quantidade, valor_pago, cliente_nome, cliente_cpf, " +
  "cliente_telefone, cep, rua, numero, complemento, bairro, cidade, estado, automacao_status, automacao_tentativas";

export const MAX_TENTATIVAS = 3;

// Por enquanto o robô só sabe comprar na Loja Santuário Nacional (VTEX).
// Pedidos de outras lojas (ex: desatadoradosnosoficial.com.br, WooCommerce)
// ficam de fora da automação e continuam no fluxo manual do painel /admin.
export const DOMINIO_SUPORTADO = "lojasantuarionacional.com.br";

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

// `assistido`: fila rodando no computador do usuário, com navegador na tela
// e uma pessoa pra marcar o captcha. Sem isso, é o worker do servidor.
export async function processarPedido(pedido: PedidoRow, assistido?: OpcoesAssistido): Promise<ResultadoCompra> {
  console.log(`[${pedido.id}] iniciando compra automática (tentativa ${pedido.automacao_tentativas + 1})`);
  await marcarProcessando(pedido.id);

  // Rede de segurança: qualquer erro inesperado aqui (não só os que
  // executarCompra já trata) precisa sempre tirar o pedido de
  // "processando" — senão ele fica travado pra sempre, porque a busca só
  // pega pedidos em "pendente"/"aprovado".
  let resultado: ResultadoCompra;
  try {
    if (assistido) {
      // Na fila assistida a pessoa vê cada pedido antes e marca o captcha,
      // então ela é a aprovação — o teto de valor não se aplica.
      resultado = await executarCompra(pedido, { headless: false, assistido, ignorarTeto: true });
    } else {
      const jaAprovado = pedido.automacao_status === "aprovado";
      resultado = jaAprovado
        ? await executarCompraAprovada(pedido)
        : await executarCompra(pedido, {
            // Só pra acompanhar testes locais: WORKER_HEADLESS=false abre o
            // navegador na tela e WORKER_GRAVAR_VIDEO=<pasta> grava vídeo.
            headless: process.env.WORKER_HEADLESS !== "false",
            gravarVideoEm: process.env.WORKER_GRAVAR_VIDEO || undefined,
          });
    }
  } catch (err) {
    console.error(`[${pedido.id}] erro inesperado:`, err);
    const erro = err instanceof Error ? err.message : String(err);
    await supabase
      .from("pedidos")
      .update({
        automacao_status: "falhou",
        automacao_erro: erro,
        automacao_tentativas: pedido.automacao_tentativas + 1,
        automacao_atualizado_em: new Date().toISOString(),
      })
      .eq("id", pedido.id);
    return { sucesso: false, precisaAprovacao: false, erro, screenshot: Buffer.alloc(0) };
  }

  const screenshotPath = await salvarScreenshot(pedido.id, resultado.screenshot);

  if (!resultado.sucesso) {
    console.error(`[${pedido.id}] falhou:`, resultado.erro);
    await supabase
      .from("pedidos")
      .update({
        // Sem cobrança garantida (ex.: captcha não marcado) → volta pra fila.
        automacao_status: resultado.podeTentarDeNovo ? "pendente" : "falhou",
        automacao_erro: resultado.erro ?? "Erro desconhecido",
        automacao_screenshot_path: screenshotPath,
        automacao_tentativas: resultado.podeTentarDeNovo ? pedido.automacao_tentativas : pedido.automacao_tentativas + 1,
        automacao_atualizado_em: new Date().toISOString(),
      })
      .eq("id", pedido.id);
    return resultado;
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
    return resultado;
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
  return resultado;
}
