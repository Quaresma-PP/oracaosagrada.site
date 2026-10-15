// Script único pra rodar o robô LOCAL com navegador visível, só pra
// demonstração — não é usado em produção (o worker de verdade roda
// headless no Railway, via index.ts).
import { createClient } from "@supabase/supabase-js";
import { executarCompra } from "./comprador.js";
import { config } from "./config.js";
import type { PedidoRow } from "./types.js";

const PEDIDO_ID = process.argv[2];
// --testar-pagamento: preenche o cartão e para ANTES de finalizar (não paga).
const TESTAR_PAGAMENTO = process.argv.includes("--testar-pagamento");
// --gravar: salva um vídeo (.webm) do navegador na pasta videos/.
const GRAVAR = process.argv.includes("--gravar");
// --url=<link>: troca o produto só na memória (não grava no banco), pra testar
// outro produto reaproveitando os dados de cliente de um pedido de teste.
const arg = (nome: string) => process.argv.find((a) => a.startsWith(`--${nome}=`))?.slice(nome.length + 3);
const URL_PRODUTO = arg("url");
// --comprar: FINALIZA A COMPRA DE VERDADE (cobra no cartão), ignorando
// COMPRA_MODO=validacao. A trava de VALOR_MAXIMO continua valendo.
const COMPRAR = process.argv.includes("--comprar");
// --nome= --cep= --numero= --complemento=: troca destinatário/endereço só na
// memória — pra compra de teste chegar num endereço real.
const ENDERECO = { nome: arg("nome"), cep: arg("cep"), numero: arg("numero"), complemento: arg("complemento") };
if (!PEDIDO_ID) {
  console.error("Uso: npx tsx --env-file=.env src/demo-local.ts <id-do-pedido> [--testar-pagamento] [--gravar] [--url=<link do produto>] [--comprar] [--nome= --cep= --numero= --complemento=]");
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const CAMPOS_PEDIDO =
  "id, produto_nome, produto_url_oficial, quantidade, valor_pago, cliente_nome, cliente_cpf, " +
  "cliente_telefone, cep, rua, numero, complemento, bairro, cidade, estado, automacao_status, automacao_tentativas";

async function main() {
  const { data, error } = await supabase.from("pedidos").select(CAMPOS_PEDIDO).eq("id", PEDIDO_ID).single();
  if (error || !data) {
    console.error("Pedido não encontrado:", error?.message);
    process.exit(1);
  }

  const pedido = data as unknown as PedidoRow;
  if (URL_PRODUTO) {
    pedido.produto_url_oficial = URL_PRODUTO;
    pedido.produto_nome = URL_PRODUTO;
    pedido.quantidade = 1;
  }
  if (ENDERECO.nome) pedido.cliente_nome = ENDERECO.nome;
  if (ENDERECO.cep) pedido.cep = ENDERECO.cep.replace(/\D/g, "");
  if (ENDERECO.numero) pedido.numero = ENDERECO.numero;
  if (ENDERECO.complemento !== undefined) pedido.complemento = ENDERECO.complemento || null;
  if (COMPRAR) {
    if (TESTAR_PAGAMENTO) throw new Error("Use --comprar OU --testar-pagamento, não os dois.");
    config.compraModo = "automatico";
    console.log(`ATENÇÃO: compra de verdade — entrega para ${pedido.cliente_nome}, CEP ${pedido.cep}, nº ${pedido.numero}`);
  }
  console.log("Rodando com navegador visível pro pedido:", pedido.produto_nome);
  const resultado = await executarCompra(pedido, {
    headless: false,
    pausaAntesDeFecharMs: 60000,
    testarPagamentoSemFinalizar: TESTAR_PAGAMENTO,
    gravarVideoEm: GRAVAR ? "videos" : undefined,
  });
  if (GRAVAR) console.log("Vídeo salvo na pasta worker-compra-automatica/videos");
  console.log("Resultado:", {
    sucesso: resultado.sucesso,
    precisaAprovacao: resultado.precisaAprovacao,
    numeroPedidoLoja: resultado.numeroPedidoLoja,
    erro: resultado.erro,
  });
}

main();
