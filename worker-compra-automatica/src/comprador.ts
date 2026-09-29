// Automação de compra na Loja Santuário Nacional (VTEX FastStore).
//
// Os seletores de carrinho → dados pessoais → endereço → chegada na tela
// de pagamento foram validados com uma gravação real do Playwright Inspector
// (2026-09-29), usando um e-mail de visitante (fluxo guest checkout).
//
// AINDA EM ABERTO: a gravação usou um e-mail de teste, não a conta real da
// loja (com senha e cartão salvo) — por isso os passos de login-com-senha
// (passo2Login, quando a conta já existe) e seleção de cartão salvo
// (passo5SelecionarPagamentoSalvo) continuam com seletores best-effort, não
// confirmados. Precisam de uma gravação nova logada na conta de verdade
// antes de confiar no modo automático de pagamento.
import { chromium, type Browser, type Page } from "playwright";
import { config } from "./config.js";
import type { PedidoRow } from "./types.js";

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
    await passo2DadosPessoais(page, pedido);
    await passo3Endereco(page, pedido);
    const totalCarrinho = await passo4ChegarNoPagamento(page);

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
// dados + endereço, que são idempotentes/rápidos) e, dessa vez, sempre
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

// O banner de cookies fica fixo na tela e cobre botões importantes.
// Chamado mais de uma vez ao longo do fluxo porque ele pode demorar pra
// renderizar ou reaparecer.
async function fecharBannerCookies(page: Page) {
  const aceitarCookies = page.getByRole("button", { name: "Aceitar" });
  if (await aceitarCookies.isVisible({ timeout: 8000 }).catch(() => false)) {
    await aceitarCookies.click().catch(() => {});
    await page.waitForTimeout(500);
  }
}

function primeiroEUltimoNome(nomeCompleto: string): { primeiro: string; ultimo: string } {
  const partes = nomeCompleto.trim().split(/\s+/);
  return {
    primeiro: partes[0] ?? nomeCompleto,
    ultimo: partes.length > 1 ? partes.slice(1).join(" ") : partes[0] ?? nomeCompleto,
  };
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

  // Confirmado por gravação real: o botão de comprar é exatamente "Comprar".
  await page.getByRole("button", { name: "Comprar" }).click();

  // Confirma que o item foi realmente adicionado antes de seguir.
  await page.waitForTimeout(1500);
  const carrinhoVazio = await page
    .getByText(/carrinho est[áa] vazio/i)
    .isVisible({ timeout: 3000 })
    .catch(() => false);
  if (carrinhoVazio) {
    throw new Error("Cliquei em Comprar mas o carrinho continuou vazio.");
  }

  await fecharBannerCookies(page);

  // Gravação real mostrou dois cliques até sair do carrinho: o botão
  // genérico do painel (testid fs-button) e depois o link/botão
  // "Finalizar pedido" — em qualquer uma das duas formas que aparecer.
  const botaoPainel = page.getByTestId("fs-button");
  if (await botaoPainel.first().isVisible({ timeout: 3000 }).catch(() => false)) {
    await botaoPainel.first().click();
    await page.waitForTimeout(500);
  }

  const finalizarPedido = page
    .getByRole("link", { name: /finalizar pedido/i })
    .or(page.getByRole("button", { name: /finalizar pedido/i }));
  await finalizarPedido.first().click({ timeout: 10000 });

  // O checkout pode abrir numa etapa intermediária de revisão do carrinho
  // ("Sacola") com outro botão igual — clica de novo se ele aparecer.
  await page.waitForTimeout(1000);
  const finalizarDeNovo = page.getByRole("button", { name: /finalizar pedido/i });
  if (await finalizarDeNovo.first().isVisible({ timeout: 3000 }).catch(() => false)) {
    await finalizarDeNovo.first().click();
  }
}

async function passo2DadosPessoais(page: Page, pedido: PedidoRow) {
  await page.waitForLoadState("domcontentloaded");

  const campoEmail = page.getByPlaceholder("seu@email.com");
  await campoEmail.click({ timeout: 15000 });
  await campoEmail.fill(config.storeLoginEmail);
  await page.getByRole("button", { name: "Continuar" }).click();

  // Se a conta já existe, pode pedir senha aqui antes de mostrar os campos
  // de nome — ainda não confirmado com a conta real (login-por-senha).
  const campoSenha = page.getByPlaceholder(/senha/i).or(page.getByLabel(/senha/i));
  const pediuSenha = await campoSenha.first().isVisible({ timeout: 4000 }).catch(() => false);
  if (pediuSenha) {
    await campoSenha.first().fill(config.storeLoginSenha);
    await page.getByRole("button", { name: /entrar|confirmar|continuar/i }).first().click();
    await page.waitForTimeout(1000);
  }

  // Campos de nome só aparecem no fluxo de visitante/primeira compra — se
  // já logado numa conta existente com dados salvos, isso pode não aparecer.
  const { primeiro, ultimo } = primeiroEUltimoNome(pedido.cliente_nome);
  const campoPrimeiroNome = page.getByLabel("Primeiro nome");
  if (await campoPrimeiroNome.isVisible({ timeout: 5000 }).catch(() => false)) {
    await campoPrimeiroNome.fill(primeiro);
    await page.getByLabel("Último nome").fill(ultimo);
    await page.getByPlaceholder("999.999.999-").fill(pedido.cliente_cpf);
    await page.getByPlaceholder("99999-9999").fill(pedido.cliente_telefone ?? "");
  }

  await page.getByRole("button", { name: "Ir para a Entrega" }).click({ timeout: 10000 });
}

async function passo3Endereco(page: Page, pedido: PedidoRow) {
  await page.waitForLoadState("domcontentloaded");

  const campoCep = page.getByPlaceholder("Digite o CEP");
  await campoCep.fill(pedido.cep ?? "", { timeout: 15000 });
  await page.waitForTimeout(1500); // dá tempo do autofill de rua/bairro/cidade rodar

  const campoNumero = page.getByLabel("Número");
  if (await campoNumero.isVisible({ timeout: 3000 }).catch(() => false)) {
    await campoNumero.fill(pedido.numero ?? "");
  }

  if (pedido.complemento) {
    const campoComplemento = page.getByPlaceholder("Opcional");
    if (await campoComplemento.isVisible({ timeout: 2000 }).catch(() => false)) {
      await campoComplemento.fill(pedido.complemento);
    }
  }

  // Destinatário — preenche só se estiver vazio (a loja pode preencher
  // sozinho a partir do nome já informado na etapa anterior).
  const campoDestinatario = page.getByLabel("Destinatário");
  if (await campoDestinatario.isVisible({ timeout: 2000 }).catch(() => false)) {
    const atual = await campoDestinatario.inputValue().catch(() => "");
    if (!atual) await campoDestinatario.fill(pedido.cliente_nome);
  }

  // Se aparecer uma lista de opções de frete, marca a primeira — não visto
  // na gravação real (pode ter sido auto-selecionada), mantido por segurança.
  const opcaoFrete = page.getByRole("radio").first();
  if (await opcaoFrete.isVisible({ timeout: 3000 }).catch(() => false)) {
    await opcaoFrete.check().catch(() => {});
  }

  await page.getByRole("button", { name: "Ir para o pagamento" }).click({ timeout: 10000 });
}

async function passo4ChegarNoPagamento(page: Page): Promise<number | null> {
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

// AINDA NÃO CONFIRMADO com a conta real — precisa de gravação logada com
// usuário/senha reais pra ver como o cartão salvo aparece nessa loja.
async function passo5SelecionarPagamentoSalvo(page: Page) {
  const cartaoSalvo = page.getByText(/cartão .*final|•••• ?\d{4}/i);
  await cartaoSalvo.first().click({ timeout: 10000 });

  if (config.storeCardCvv) {
    const campoCvv = page.getByPlaceholder(/cvv|código de segurança/i).or(page.getByLabel(/cvv|código de segurança/i));
    if (await campoCvv.first().isVisible({ timeout: 3000 }).catch(() => false)) {
      await campoCvv.first().fill(config.storeCardCvv);
    }
  }
}

// AINDA NÃO CONFIRMADO — o texto exato do botão final não apareceu na
// gravação (o cartão de teste usado era inválido e travou antes de chegar
// nele).
async function passo6FinalizarCompra(page: Page): Promise<string | undefined> {
  const finalizar = page.getByRole("button", { name: /finalizar compra|finalizar pedido|confirmar pedido|pagar/i });
  await finalizar.first().click({ timeout: 10000 });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});

  const textoConfirmacao = await page.getByText(/pedido n[úu]mero|número do pedido|pedido #/i).first().textContent().catch(() => null);
  const match = textoConfirmacao?.match(/(\d[\d.\-]{3,})/);
  return match?.[1];
}
