// Automação de compra na Loja Santuário Nacional (VTEX FastStore).
//
// IMPORTANTE — leia antes de rodar em produção:
// A Loja Santuário Nacional roda em VTEX FastStore (confirmado pelos headers
// HTTP do site), que gera nomes de classe CSS aleatórios a cada build. Por
// isso este arquivo usa seletores por TEXTO/ROLE (getByRole, getByText,
// getByLabel) em vez de classes CSS — são muito mais estáveis, mas ainda
// dependem dos textos reais que a loja usa ("Entrar", "Adicionar à sacola",
// "Finalizar compra", etc.), que eu não pude conferir ao vivo (não tenho
// como abrir um navegador de verdade contra o site a partir daqui).
//
// Antes do primeiro uso real, rode `npm run codegen` (abre o Playwright
// Inspector no site) logado na conta, clique manualmente em cada passo do
// fluxo abaixo e compare/ajuste os textos e seletores aqui com o que o
// Inspector mostrar. Cada passo está isolado numa função `passoN` pra
// facilitar o ajuste individual sem mexer no resto.
import { chromium, type Browser, type Page } from "playwright";
import { config } from "./config.js";
import type { PedidoRow } from "./types.js";

const LOJA_URL = "https://www.lojasantuarionacional.com.br";

export interface ResultadoCompra {
  sucesso: boolean;
  precisaAprovacao: boolean;
  numeroPedidoLoja?: string;
  erro?: string;
  screenshot: Buffer;
}

export async function executarCompra(pedido: PedidoRow): Promise<ResultadoCompra> {
  if (!pedido.produto_url_oficial) {
    return {
      sucesso: false,
      precisaAprovacao: false,
      erro: "Pedido sem produto_url_oficial — não dá pra saber o que comprar.",
      screenshot: Buffer.alloc(0),
    };
  }

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ locale: "pt-BR" });
    const page = await context.newPage();

    await passo1AbrirProdutoEAdicionarAoCarrinho(page, pedido);
    await passo2Login(page);
    await passo3PreencherEnderecoDeEntrega(page, pedido);
    const totalCarrinho = await passo4SelecionarFreteEChegarNoPagamento(page);

    // Trava de segurança: nunca paga sozinho acima do teto configurado,
    // mesmo em modo automático — protege contra produto/preço errado.
    const acimaDoTeto = totalCarrinho !== null && totalCarrinho > config.valorMaximoCompraAutomatica;
    const deveParar = config.compraModo === "validacao" || acimaDoTeto;

    if (deveParar) {
      const screenshot = await page.screenshot({ fullPage: true });
      return { sucesso: true, precisaAprovacao: true, screenshot };
    }

    await passo5SelecionarPagamentoSalvo(page);
    const numeroPedidoLoja = await passo6FinalizarCompra(page);
    const screenshot = await page.screenshot({ fullPage: true });

    return { sucesso: true, precisaAprovacao: false, numeroPedidoLoja, screenshot };
  } catch (err) {
    const page = browser?.contexts()[0]?.pages()[0];
    const screenshot = page ? await page.screenshot({ fullPage: true }).catch(() => Buffer.alloc(0)) : Buffer.alloc(0);
    return {
      sucesso: false,
      precisaAprovacao: false,
      erro: err instanceof Error ? err.message : String(err),
      screenshot,
    };
  } finally {
    await browser?.close();
  }
}

// Retoma uma compra já aprovada pelo admin: refaz os passos 1-4 (carrinho +
// endereço + frete, que são idempotentes/rápidos) e, dessa vez, sempre
// finaliza — sem essa função, cada aprovação exigiria manter uma sessão de
// navegador aberta esperando indefinidamente, o que é frágil em um worker
// que pode reiniciar.
export async function executarCompraAprovada(pedido: PedidoRow): Promise<ResultadoCompra> {
  const original = config.compraModo;
  config.compraModo = "automatico";
  try {
    return await executarCompra(pedido);
  } finally {
    config.compraModo = original;
  }
}

// O banner de cookies fica fixo na tela e cobre botões importantes (já
// vimos ele tampar o botão de finalizar o carrinho). Chamado mais de uma
// vez ao longo do fluxo porque ele pode demorar pra renderizar ou
// reaparecer.
async function fecharBannerCookies(page: Page) {
  const aceitarCookies = page.getByRole("button", { name: /^aceitar$/i });
  if (await aceitarCookies.isVisible({ timeout: 8000 }).catch(() => false)) {
    await aceitarCookies.click().catch(() => {});
    await page.waitForTimeout(500);
  }
}

async function passo1AbrirProdutoEAdicionarAoCarrinho(page: Page, pedido: PedidoRow) {
  await page.goto(pedido.produto_url_oficial!, { waitUntil: "domcontentloaded" });
  await fecharBannerCookies(page);

  if (pedido.quantidade > 1) {
    const inputQuantidade = page.getByRole("spinbutton").first();
    if (await inputQuantidade.isVisible({ timeout: 3000 }).catch(() => false)) {
      await inputQuantidade.fill(String(pedido.quantidade));
    }
  }

  // O site usa "carrinho" (não "sacola") — confirmado pelo painel
  // "MEU CARRINHO" que abre ao clicar em comprar.
  const botaoComprar = page.getByRole("button", {
    name: /adicionar ao carrinho|adicionar (à|a) sacola|comprar agora|comprar/i,
  });
  await botaoComprar.first().click();

  // Confirma que o item foi realmente adicionado (o painel abre mesmo
  // quando o carrinho continua vazio, então só abrir não é garantia).
  await page.waitForTimeout(1500);
  const carrinhoVazio = await page
    .getByText(/carrinho est[áa] vazio/i)
    .isVisible({ timeout: 3000 })
    .catch(() => false);
  if (carrinhoVazio) {
    throw new Error(
      "Cliquei em comprar mas o carrinho continuou vazio — o botão certo pode ser outro (ajustar seletor em passo1)."
    );
  }

  // O banner de cookies pode ter reaparecido ou ainda não ter sido
  // fechado a tempo — ele fica exatamente em cima do botão de checkout.
  await fecharBannerCookies(page);

  // Texto confirmado por print real: "FINALIZAR PEDIDO". Mantém as outras
  // variantes como fallback pra outros temas/lojas.
  const irParaCarrinho = page
    .getByRole("link", { name: /finalizar pedido|finalizar compra|fechar pedido|ir para o carrinho|ver carrinho/i })
    .or(
      page.getByRole("button", {
        name: /finalizar pedido|finalizar compra|fechar pedido|ir para o carrinho|ver carrinho/i,
      })
    );
  await irParaCarrinho.first().click({ timeout: 10000 });
}

async function passo2Login(page: Page) {
  await page.waitForLoadState("domcontentloaded");

  const jaLogado = await page.getByText(config.storeLoginEmail, { exact: false }).isVisible({ timeout: 3000 }).catch(() => false);
  if (jaLogado) return;

  const botaoEntrar = page.getByRole("button", { name: /entrar|login|identifique-se/i });
  if (await botaoEntrar.first().isVisible({ timeout: 5000 }).catch(() => false)) {
    await botaoEntrar.first().click();
  }

  const campoEmail = page.getByPlaceholder(/e-mail|email/i).or(page.getByLabel(/e-mail|email/i));
  await campoEmail.first().fill(config.storeLoginEmail, { timeout: 10000 });

  const continuar = page.getByRole("button", { name: /continuar|avançar|próximo/i });
  if (await continuar.first().isVisible({ timeout: 3000 }).catch(() => false)) {
    await continuar.first().click();
  }

  const campoSenha = page.getByPlaceholder(/senha/i).or(page.getByLabel(/senha/i));
  const temCampoSenha = await campoSenha.first().isVisible({ timeout: 8000 }).catch(() => false);

  if (!temCampoSenha) {
    throw new Error(
      "Não encontrei campo de senha após o e-mail — a conta pode estar configurada pra login por " +
        "código enviado no e-mail (passwordless), que não dá pra automatizar sem acesso à caixa de entrada. " +
        "Verifique nas configurações da conta na loja se dá pra ativar login por senha."
    );
  }

  await campoSenha.first().fill(config.storeLoginSenha);
  await page.getByRole("button", { name: /entrar|confirmar|continuar/i }).first().click();
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
}

async function passo3PreencherEnderecoDeEntrega(page: Page, pedido: PedidoRow) {
  // Escolhe explicitamente "novo endereço" — NUNCA reaproveita um endereço
  // salvo na conta, porque o pedido é sempre pra um cliente diferente.
  const novoEndereco = page.getByRole("button", { name: /novo endereço|adicionar endereço|outro endereço/i });
  if (await novoEndereco.first().isVisible({ timeout: 5000 }).catch(() => false)) {
    await novoEndereco.first().click();
  }

  const campoCep = page.getByPlaceholder(/cep/i).or(page.getByLabel(/cep/i));
  await campoCep.first().fill(pedido.cep ?? "", { timeout: 10000 });
  await page.waitForTimeout(1500); // dá tempo do autofill de rua/bairro/cidade rodar

  await preencherSeVazio(page, /número/i, pedido.numero ?? "");
  if (pedido.complemento) await preencherSeVazio(page, /complemento/i, pedido.complemento);
  await preencherSeVazio(page, /bairro/i, pedido.bairro ?? "");
  await preencherSeVazio(page, /rua|logradouro|endereço/i, pedido.rua ?? "");
  await preencherSeVazio(page, /cidade/i, pedido.cidade ?? "");

  const campoNomeDestinatario = page.getByPlaceholder(/nome completo|destinatário/i);
  if (await campoNomeDestinatario.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await campoNomeDestinatario.first().fill(pedido.cliente_nome);
  }

  const avancar = page.getByRole("button", { name: /continuar|ir para entrega|avançar/i });
  await avancar.first().click({ timeout: 10000 });
}

async function preencherSeVazio(page: Page, label: RegExp, valor: string) {
  if (!valor) return;
  const campo = page.getByPlaceholder(label).or(page.getByLabel(label));
  const el = campo.first();
  if (!(await el.isVisible({ timeout: 2000 }).catch(() => false))) return;
  const atual = await el.inputValue().catch(() => "");
  if (!atual) await el.fill(valor);
}

async function passo4SelecionarFreteEChegarNoPagamento(page: Page): Promise<number | null> {
  // Pega a primeira opção de frete disponível (a mais simples de automatizar
  // de forma confiável; se quiser priorizar frete mais barato, ajuste aqui).
  const opcaoFrete = page.getByRole("radio").first();
  if (await opcaoFrete.isVisible({ timeout: 5000 }).catch(() => false)) {
    await opcaoFrete.check();
  }

  const irParaPagamento = page.getByRole("button", { name: /ir para pagamento|continuar|avançar/i });
  await irParaPagamento.first().click({ timeout: 10000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  const totalTexto = await page
    .getByText(/total/i)
    .locator("xpath=..")
    .first()
    .textContent()
    .catch(() => null);

  if (!totalTexto) return null;
  const match = totalTexto.replace(/\./g, "").match(/(\d+,\d{2})/);
  if (!match) return null;
  return Number(match[1].replace(",", "."));
}

async function passo5SelecionarPagamentoSalvo(page: Page) {
  const cartaoSalvo = page.getByText(/cartão .*final|•••• ?\d{4}/i);
  await cartaoSalvo.first().click({ timeout: 10000 });

  if (config.storeCardCvv) {
    const campoCvv = page.getByPlaceholder(/cvv|código de segurança/i).or(page.getByLabel(/cvv/i));
    if (await campoCvv.first().isVisible({ timeout: 3000 }).catch(() => false)) {
      await campoCvv.first().fill(config.storeCardCvv);
    }
  }
}

async function passo6FinalizarCompra(page: Page): Promise<string | undefined> {
  const finalizar = page.getByRole("button", { name: /finalizar compra|confirmar pedido|pagar/i });
  await finalizar.first().click({ timeout: 10000 });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});

  const textoConfirmacao = await page.getByText(/pedido n[úu]mero|número do pedido|pedido #/i).first().textContent().catch(() => null);
  const match = textoConfirmacao?.match(/(\d[\d.\-]{3,})/);
  return match?.[1];
}
