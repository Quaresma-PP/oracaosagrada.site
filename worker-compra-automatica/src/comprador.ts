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
import { chromium, type Browser, type Frame, type Locator, type Page } from "playwright";
import { config } from "./config.js";
import type { PedidoRow } from "./types.js";

export interface ResultadoCompra {
  sucesso: boolean;
  precisaAprovacao: boolean;
  numeroPedidoLoja?: string;
  erro?: string;
  // true quando a falha garantidamente não gerou cobrança e o pedido pode
  // voltar pra fila (ex.: ninguém marcou o captcha a tempo).
  podeTentarDeNovo?: boolean;
  screenshot: Buffer;
}

// Modo assistido (fila no computador do usuário): o robô faz tudo, clica em
// "Finalizar compra" e, se a loja pedir o reCAPTCHA, chama uma pessoa pra
// marcar — o robô NUNCA interage com o captcha.
export interface OpcoesAssistido {
  legenda: string;
  aoPedirAtencao: (mensagem: string) => void;
  esperaMaximaMs: number;
}

class CaptchaNaoResolvido extends Error {}

export async function executarCompra(
  pedido: PedidoRow,
  opts?: {
    headless?: boolean;
    pausaAntesDeFecharMs?: number;
    testarPagamentoSemFinalizar?: boolean;
    gravarVideoEm?: string;
    assistido?: OpcoesAssistido;
    // Uma pessoa já aprovou este pedido (painel ou fila assistida).
    ignorarTeto?: boolean;
  }
): Promise<ResultadoCompra> {
  if (!pedido.produto_url_oficial) {
    return {
      sucesso: false,
      precisaAprovacao: false,
      erro: "Pedido sem produto_url_oficial — não dá pra saber o que comprar.",
      screenshot: Buffer.alloc(0),
    };
  }

  // Sem CEP/número o passo3 não troca o endereço e a compra iria pro
  // endereço SALVO na conta da loja (visto em produção, 2026-10-16).
  const cep = (pedido.cep ?? "").replace(/\D/g, "");
  if (cep.length !== 8 || !pedido.numero?.trim()) {
    return {
      sucesso: false,
      precisaAprovacao: false,
      erro: `Pedido sem endereço completo (CEP "${pedido.cep ?? ""}", número "${pedido.numero ?? ""}") — não dá pra entregar. Compra manual.`,
      screenshot: Buffer.alloc(0),
    };
  }

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: opts?.headless ?? true,
      slowMo: opts?.headless === false ? 400 : 0,
      // Deixa a página tocar o som de aviso sem precisar de clique antes.
      args: opts?.assistido ? ["--autoplay-policy=no-user-gesture-required"] : [],
    });
    const tamanho = { width: 1280, height: 800 };
    const context = await browser.newContext({
      locale: "pt-BR",
      viewport: tamanho,
      // Sem isso o Chromium headless se identifica como "HeadlessChrome" e a
      // loja não adiciona o produto ao carrinho (confirmado em 2026-10-15).
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      // O vídeo só é gravado no disco quando o navegador fecha (no finally).
      recordVideo: opts?.gravarVideoEm ? { dir: opts.gravarVideoEm, size: tamanho } : undefined,
    });
    const page = await context.newPage();

    await passo1AbrirProdutoEAdicionarAoCarrinho(page, pedido);
    await passo2DadosPessoais(page, pedido);
    await passo3Endereco(page, pedido);
    const totalCarrinho = await passo4ChegarNoPagamento(page);

    // Só pra teste local: preenche o pagamento e para antes de finalizar.
    if (opts?.testarPagamentoSemFinalizar) {
      await passo5SelecionarPagamentoSalvo(page);
      const botao = await acharBotaoFinalizar(page);
      console.log("Botão que seria clicado:", await botao.boundingBox());
      const screenshot = await page.screenshot({ fullPage: true });
      if (opts.pausaAntesDeFecharMs) await page.waitForTimeout(opts.pausaAntesDeFecharMs);
      return { sucesso: true, precisaAprovacao: true, screenshot };
    }

    // Trava de segurança: nunca paga sozinho acima do teto configurado,
    // mesmo em modo automático — protege contra produto/preço errado.
    const acimaDoTeto = totalCarrinho !== null && totalCarrinho > config.valorMaximoCompraAutomatica;
    const deveParar = (!opts?.assistido && config.compraModo === "validacao") || (acimaDoTeto && !opts?.ignorarTeto);

    if (deveParar) {
      const screenshot = await page.screenshot({ fullPage: true });
      if (opts?.pausaAntesDeFecharMs) await page.waitForTimeout(opts.pausaAntesDeFecharMs);
      return { sucesso: true, precisaAprovacao: true, screenshot };
    }

    await passo5SelecionarPagamentoSalvo(page);
    const numeroPedidoLoja = await passo6FinalizarCompra(page, opts?.assistido, totalCarrinho);
    const screenshot = await page.screenshot({ fullPage: true });
    if (opts?.pausaAntesDeFecharMs) await page.waitForTimeout(opts.pausaAntesDeFecharMs);

    return { sucesso: true, precisaAprovacao: false, numeroPedidoLoja, screenshot };
  } catch (err) {
    const page = browser?.contexts()[0]?.pages()[0];
    const screenshot = page ? await page.screenshot({ fullPage: true }).catch(() => Buffer.alloc(0)) : Buffer.alloc(0);
    return {
      sucesso: false,
      precisaAprovacao: false,
      erro: err instanceof Error ? err.message : String(err),
      podeTentarDeNovo: err instanceof CaptchaNaoResolvido,
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
    return await executarCompra(pedido, { ignorarTeto: true });
  } finally {
    config.compraModo = original;
  }
}

// Espera o elemento ficar visível por até `ms`. Não usar
// `locator.isVisible({ timeout })`: o Playwright ignora esse timeout e só
// olha a tela no instante da chamada.
function aparece(locator: Locator, ms: number): Promise<boolean> {
  return locator
    .first()
    .waitFor({ state: "visible", timeout: ms })
    .then(() => true)
    .catch(() => false);
}

// O banner de cookies fica fixo na tela e cobre botões importantes.
// Chamado mais de uma vez ao longo do fluxo porque ele pode demorar pra
// renderizar ou reaparecer.
async function fecharBannerCookies(page: Page) {
  const aceitarCookies = page.getByRole("button", { name: "Aceitar" });
  if (await aparece(aceitarCookies, 8000)) {
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

export async function passo1AbrirProdutoEAdicionarAoCarrinho(page: Page, pedido: PedidoRow) {
  await page.goto(pedido.produto_url_oficial!, { waitUntil: "domcontentloaded" });
  await fecharBannerCookies(page);

  if (pedido.quantidade > 1) {
    const inputQuantidade = page.getByRole("spinbutton").first();
    if (await aparece(inputQuantidade, 3000)) {
      await inputQuantidade.fill(String(pedido.quantidade));
    }
  }

  // Confirmado por gravação real: o botão de comprar é exatamente "Comprar".
  // Clicar antes da página terminar de carregar às vezes não adiciona nada,
  // então espera a rede acalmar e tenta até 3 vezes.
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  let adicionou = false;
  for (let tentativa = 1; tentativa <= 3 && !adicionou; tentativa++) {
    await fecharBannerCookies(page);
    await page.getByRole("button", { name: "Comprar" }).click();
    // O mini carrinho abre vazio e só atualiza depois — espera a mensagem sumir.
    await page.waitForTimeout(1500);
    adicionou = await page
      .getByText(/carrinho est[áa] vazio/i)
      .waitFor({ state: "hidden", timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    if (!adicionou) {
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(2000);
    }
  }
  if (!adicionou) {
    throw new Error("Cliquei em Comprar 3 vezes mas o carrinho continuou vazio.");
  }

  await fecharBannerCookies(page);

  // Mini carrinho lateral: o botão "Finalizar pedido" tem uma classe própria
  // (minicartFooter_finalizePurchaseButton). Não usar o testid genérico
  // "fs-button" — ele também casa com botões de formulário da página.
  const botaoMiniCarrinho = page.locator('button[class*="finalizePurchaseButton"]');
  if (await aparece(botaoMiniCarrinho.first(), 5000)) {
    await botaoMiniCarrinho.first().click();
    await page.waitForTimeout(1500);
  }

  // Página da sacola (/checkout/#/cart): mais um "Finalizar pedido".
  await fecharBannerCookies(page);
  const finalizarPedido = page
    .getByRole("link", { name: /finalizar pedido/i })
    .or(page.getByRole("button", { name: /finalizar pedido/i }));
  if (await aparece(finalizarPedido.first(), 10000)) {
    await finalizarPedido.first().click();
  }

  // O checkout pode abrir numa etapa intermediária de revisão do carrinho
  // ("Sacola") com outro botão igual — clica de novo se ele aparecer.
  await page.waitForTimeout(1000);
  const finalizarDeNovo = page.getByRole("button", { name: /finalizar pedido/i });
  if (await aparece(finalizarDeNovo.first(), 3000)) {
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
  const pediuSenha = await aparece(campoSenha.first(), 4000);
  if (pediuSenha) {
    if (!config.storeLoginSenha) throw new Error("A loja pediu senha e STORE_LOGIN_SENHA não está configurada.");
    await campoSenha.first().fill(config.storeLoginSenha);
    await page.getByRole("button", { name: /entrar|confirmar|continuar/i }).first().click();
    await page.waitForTimeout(1000);
  }

  // Conta com compras anteriores: a loja mostra "Identificamos seus dados" e
  // pula direto pro pagamento, com nome e o ENDEREÇO SALVO da conta. Nesse
  // caso abre a entrega e escolhe "Entregar em outro endereço", pro passo3
  // preencher o endereço do cliente (confirmado em 2026-10-15).
  // A janela demora alguns segundos e os campos de nome chegam a ficar
  // liberados por um instante antes dela — por isso espera a janela primeiro
  // (até 15s) e só cai no fluxo de visitante se ela não vier.
  const continuarComACompra = page.getByRole("button", { name: /continuar com a compra/i });
  if (await aparece(continuarComACompra, 15000)) {
    await continuarComACompra.click();
    await page.waitForTimeout(1500);
    const editarEntrega = page.locator("#edit-shipping-data");
    if (await aparece(editarEntrega, 5000)) await editarEntrega.click();
    await page
      .getByRole("button", { name: /entregar em outro endere/i })
      .or(page.getByRole("link", { name: /entregar em outro endere/i }))
      .first()
      .click({ timeout: 10000 });
    return;
  }

  // Campos de nome só aparecem no fluxo de visitante/primeira compra — se
  // já logado numa conta existente com dados salvos, isso pode não aparecer.
  const { primeiro, ultimo } = primeiroEUltimoNome(pedido.cliente_nome);
  const campoPrimeiroNome = page.getByLabel("Primeiro nome");
  if (await aparece(campoPrimeiroNome, 5000)) {
    // O campo "CPF" da loja só aceita CPF de pessoa física (11 dígitos) —
    // pedidos com CNPJ (pessoa jurídica) não têm como preencher esse campo
    // do jeito que ele está hoje, precisa de intervenção manual.
    if (pedido.cliente_cpf.length !== 11) {
      throw new Error(
        `Documento do cliente tem ${pedido.cliente_cpf.length} dígitos (esperado 11, CPF de pessoa física) — ` +
          "provavelmente é um CNPJ, que esse checkout não aceita no campo principal. Precisa de compra manual."
      );
    }

    await campoPrimeiroNome.fill(primeiro);
    await page.getByLabel("Último nome").fill(ultimo);
    await page.getByPlaceholder("999.999.999-").fill(pedido.cliente_cpf);
    await page.getByPlaceholder("99999-9999").fill(pedido.cliente_telefone ?? "");
  }

  await page.getByRole("button", { name: "Ir para a Entrega" }).click({ timeout: 10000 });

  // Confirma que realmente saiu da etapa "Dados pessoais" — se ficar
  // travado (ex: erro de validação), falha aqui com uma mensagem clara em
  // vez de só não achar os campos da próxima etapa.
  const aindaEmDadosPessoais = await page
    .getByRole("heading", { name: /dados pessoais/i })
    .isVisible({ timeout: 4000 })
    .catch(() => false);
  if (aindaEmDadosPessoais) {
    const erroValidacao = await page.getByText(/informe um documento válido|campo obrigatório/i).first().textContent().catch(() => null);
    throw new Error(`Não avançou da etapa "Dados pessoais"${erroValidacao ? ` — erro na tela: ${erroValidacao}` : ""}.`);
  }
}

async function passo3Endereco(page: Page, pedido: PedidoRow) {
  await page.waitForLoadState("domcontentloaded");

  const campoCep = page.getByPlaceholder("Digite o CEP");
  await campoCep.fill(pedido.cep ?? "", { timeout: 15000 });

  // O CEP dispara o autofill de rua/bairro/cidade e o recálculo do frete, que
  // redesenha o formulário e APAGA o que já foi digitado em número/destinatário
  // (visto em vídeo, 2026-10-15). Por isso espera a rede acalmar e só depois
  // escolhe o frete e preenche o resto.
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const opcaoFrete = page.getByRole("radio").first();
  if (await aparece(opcaoFrete, 3000)) {
    if (!(await opcaoFrete.isChecked().catch(() => true))) {
      await opcaoFrete.check().catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
  }

  const irParaPagamento = page.getByRole("button", { name: "Ir para o pagamento" });
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    await preencherNumeroEDestinatario(page, pedido);
    await page.waitForTimeout(800);
    await irParaPagamento.click({ timeout: 10000 });

    // Se a loja apagou algum campo, mostra "Campo obrigatório" e não avança.
    const faltouCampo = await aparece(page.getByText(/campo obrigat[óo]rio/i).locator("visible=true"), 3000);
    if (!faltouCampo) return;
    await page.waitForTimeout(2000);
  }
  throw new Error('Não avançou da etapa "Entrega": a loja continua pedindo campo obrigatório.');
}

async function preencherNumeroEDestinatario(page: Page, pedido: PedidoRow) {
  const campoNumero = page.getByLabel("Número");
  if (await aparece(campoNumero, 3000)) {
    await campoNumero.fill(pedido.numero ?? "");
  }

  if (pedido.complemento) {
    const campoComplemento = page.getByPlaceholder("Opcional");
    if (await aparece(campoComplemento, 2000)) {
      await campoComplemento.fill(pedido.complemento);
    }
  }

  // Destinatário — sempre o cliente do pedido (é obrigatório, e na conta
  // identificada pode vir vazio ou com o nome do dono da conta).
  const campoDestinatario = page.getByLabel("Destinatário");
  if (await aparece(campoDestinatario, 2000)) {
    await campoDestinatario.fill(pedido.cliente_nome);
  }
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
// Se não houver cartão salvo na tela, digita o cartão das variáveis de
// ambiente (STORE_CARD_*), quando configurado.
async function passo5SelecionarPagamentoSalvo(page: Page) {
  // NUNCA usa cartão salvo na conta da loja: a conta tem cartão de terceiro
  // salvo. Sempre digita o cartão configurado em STORE_CARD_*. Se a loja
  // mostrar um cartão salvo, clica em "Usar outro cartão" pra abrir o
  // formulário de cartão novo.
  if (!config.storeCardNumero) {
    throw new Error("STORE_CARD_NUMERO não configurado — não há cartão pra pagar.");
  }

  const opcaoCartao = page.getByText(/^cartão de crédito$/i).locator("visible=true");
  if (await aparece(opcaoCartao, 5000)) await opcaoCartao.first().click().catch(() => {});

  let frame = await acharFormularioCartao(page, 10);
  if (!frame) {
    // O link pode estar na página ou dentro do iframe de pagamento da VTEX.
    for (const f of page.frames()) {
      const usarOutro = f.getByText(/usar outro cart[ãa]o/i).locator("visible=true");
      if (await usarOutro.count().catch(() => 0)) {
        await usarOutro.first().click().catch(() => {});
        frame = await acharFormularioCartao(page, 15);
        break;
      }
    }
  }
  if (!frame) throw new Error("Formulário de cartão novo não apareceu na tela de pagamento.");

  await preencherCartaoNovo(frame);
}

const SELETOR_NUMERO_CARTAO = 'input[id*="Number"], input[name*="cardNumber"]';

// O formulário fica num iframe da VTEX (io.vtexpayments.com.br) que carrega
// depois — procura em todos os frames por até `segundos`.
async function acharFormularioCartao(page: Page, segundos: number): Promise<Frame | undefined> {
  for (let i = 0; i < segundos; i++) {
    for (const f of page.frames()) {
      if (await f.locator(SELETOR_NUMERO_CARTAO).first().isVisible().catch(() => false)) return f;
    }
    await page.waitForTimeout(1000);
  }
  return undefined;
}

// AINDA NÃO CONFIRMADO — seletores do formulário padrão de cartão do
// checkout VTEX, que costuma ficar dentro de um iframe. Validar no teste
// com navegador visível.
async function preencherCartaoNovo(frame: Frame) {
  const { storeCardNumero, storeCardNome, storeCardValidade, storeCardCvv } = config;
  if (!storeCardNome || !storeCardValidade || !storeCardCvv) {
    throw new Error("Cartão incompleto: configure STORE_CARD_NOME, STORE_CARD_VALIDADE (MM/AA) e STORE_CARD_CVV.");
  }
  const [mes, ano] = storeCardValidade.split("/").map((p) => p.trim());

  // Borra os campos do cartão: não aparecem em vídeo nem nos prints que vão
  // pro painel /admin. Não interfere no preenchimento.
  await frame
    .addStyleTag({
      content:
        'input[id*="Number"], input[name*="cardNumber"], input[id*="Code"], input[name*="cvv"], ' +
        'input[name*="securityCode"], input[id*="Expir"], select[id*="Month"], select[id*="Year"], input[id^="holder-document"] { filter: blur(6px) !important; }',
    })
    .catch(() => {});

  await frame.locator(SELETOR_NUMERO_CARTAO).first().fill(storeCardNumero!);
  await frame.locator('input[id*="Name"], input[name*="cardholder"]').first().fill(storeCardNome);

  const selectMes = frame.locator('select[id*="Month"]').first();
  if (await selectMes.count()) {
    await selectMes.selectOption(mes.padStart(2, "0"));
    await frame.locator('select[id*="Year"]').first().selectOption(ano.slice(-2));
  } else {
    await frame.locator('input[id*="Expir"], input[name*="expir"], input[placeholder*="MM"]').first().fill(`${mes}/${ano.slice(-2)}`);
  }

  await frame.locator('input[id*="Code"], input[name*="cvv"], input[name*="securityCode"]').first().fill(storeCardCvv);

  // CPF do titular do cartão (campo holder-document no formulário da VTEX).
  const cpfTitular = frame.locator('input[id^="holder-document"]').first();
  if (await aparece(cpfTitular, 2000)) {
    if (!config.storeCardCpf) throw new Error("O checkout pediu o CPF do titular e STORE_CARD_CPF não está configurado.");
    await cpfTitular.fill(config.storeCardCpf);
  }

  // Parcelas: o select tem id "...Brand" (nome confuso da VTEX). A primeira
  // opção é o texto vazio "Em quantas parcelas deseja pagar?" e as opções de
  // verdade só carregam depois do número do cartão — espera e escolhe a
  // primeira opção com valor ("Pagamento à vista"). Visto em produção
  // 2026-10-16: com index 0 ficou "Campo obrigatório".
  const parcelas = frame.locator('select[id*="nstallment"], select[id$="Brand"]').first();
  let escolheuParcela = false;
  for (let i = 0; i < 15 && !escolheuParcela; i++) {
    const estado = await parcelas
      .evaluate((el: HTMLSelectElement) => ({
        atual: el.value,
        textoAtual: el.selectedOptions[0]?.text ?? "",
        primeira: [...el.options].find((o) => o.value && !o.disabled && !/em quantas parcelas/i.test(o.text))?.value ?? null,
      }))
      .catch(() => null);
    const jaEscolhida = estado && estado.atual && !/em quantas parcelas/i.test(estado.textoAtual);
    if (jaEscolhida) {
      // Confirma que continua escolhida depois do formulário se redesenhar.
      await frame.page().waitForTimeout(1500);
      const aindaEscolhida = await parcelas
        .evaluate((el: HTMLSelectElement) => !!el.value && !/em quantas parcelas/i.test(el.selectedOptions[0]?.text ?? ""))
        .catch(() => false);
      if (aindaEscolhida) escolheuParcela = true;
      continue;
    }
    if (estado?.primeira) {
      await parcelas.selectOption(estado.primeira).catch(() => {});
      // Dispara change/blur como um usuário faria (o formulário é Knockout).
      await parcelas.dispatchEvent("change").catch(() => {});
      await parcelas.blur().catch(() => {});
    }
    await frame.page().waitForTimeout(1000);
  }
  if (!escolheuParcela) throw new Error("As opções de parcelamento não carregaram no formulário do cartão.");
}

// AINDA NÃO CONFIRMADO numa compra real. Depois do clique a VTEX leva pra
// /checkout/orderPlaced?og=<número do pedido>. Se não chegar lá (cartão
// recusado, antifraude), lança erro com a mensagem da tela — o worker marca o
// pedido como "falhou" e NÃO tenta de novo, pra nunca pagar duas vezes.
// A página tem mais de um "Finalizar compra" (um da versão celular fica
// fora da tela). Escolhe o que está dentro da largura da janela — o do
// resumo do pedido. Visto em produção 2026-10-16.
async function acharBotaoFinalizar(page: Page): Promise<Locator> {
  const candidatos = page.getByRole("button", { name: /finalizar compra/i }).locator("visible=true");
  const total = await candidatos.count();
  for (let i = 0; i < total; i++) {
    const botao = candidatos.nth(i);
    const dentroDaTela = await botao
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= window.innerWidth;
      })
      .catch(() => false);
    if (dentroDaTela) return botao;
  }
  throw new Error(`Nenhum botão "Finalizar compra" dentro da tela (${total} encontrados).`);
}

async function passo6FinalizarCompra(
  page: Page,
  assistido?: OpcoesAssistido,
  totalCarrinho?: number | null
): Promise<string | undefined> {
  const finalizar = await acharBotaoFinalizar(page);
  await finalizar.click({ timeout: 10000 });

  // A loja pode abrir o reCAPTCHA ("Verificação de segurança"). Sem pessoa
  // (servidor), espera 90s e falha. No modo assistido, avisa e espera a
  // pessoa marcar; o robô não toca no captcha.
  const captcha = page.getByText(/verifica[çc][ãa]o de seguran[çc]a/i).locator("visible=true");
  const limite = Date.now() + (assistido ? assistido.esperaMaximaMs : 90000);
  let avisou = false;
  let confirmou = false;
  while (Date.now() < limite) {
    if (/orderPlaced/i.test(page.url())) {
      confirmou = true;
      break;
    }
    if (assistido && !avisou && (await captcha.count().catch(() => 0))) {
      avisou = true;
      const total = totalCarrinho != null ? ` — R$ ${totalCarrinho.toFixed(2).replace(".", ",")}` : "";
      const mensagem = `${assistido.legenda}${total}: marque "Não sou um robô" para finalizar.`;
      await page.bringToFront().catch(() => {});
      await mostrarAviso(page, mensagem);
      assistido.aoPedirAtencao(mensagem);
    }
    await page.waitForTimeout(1000);
  }

  if (!confirmou) {
    if (await captcha.count().catch(() => 0)) {
      throw new CaptchaNaoResolvido(
        `A loja pediu o captcha e ninguém marcou a tempo — pedido NÃO foi feito, volta pra fila.`
      );
    }
    const aviso = await page
      .locator(".payment-unauthorized, .alert, [class*='error'], [class*='notification']")
      .locator("visible=true")
      .first()
      .innerText()
      .catch(() => "");
    throw new Error(
      `Cliquei em "Finalizar compra" mas a loja não confirmou o pedido` +
        (aviso ? ` — mensagem na tela: ${aviso.trim().slice(0, 200)}` : "") +
        ". Conferir no site da loja antes de tentar de novo."
    );
  }

  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  const og = new URL(page.url()).searchParams.get("og");
  if (og) return og;
  const textoConfirmacao = await page.getByText(/pedido n[º°úu]|número do pedido|pedido #/i).first().textContent().catch(() => null);
  return textoConfirmacao?.match(/(\d[\w.\-]{3,})/)?.[1];
}

// Faixa amarela no topo da página + bipe, pra chamar a pessoa no captcha.
async function mostrarAviso(page: Page, mensagem: string) {
  await page
    .evaluate((texto) => {
      const faixa = document.createElement("div");
      faixa.textContent = "⚠️ " + texto;
      faixa.style.cssText =
        "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#ffd400;color:#111;" +
        "font:bold 20px sans-serif;padding:16px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3)";
      document.body.appendChild(faixa);
      try {
        const ctx = new AudioContext();
        [0, 0.35, 0.7].forEach((t) => {
          const osc = ctx.createOscillator();
          osc.frequency.value = 880;
          osc.connect(ctx.destination);
          osc.start(ctx.currentTime + t);
          osc.stop(ctx.currentTime + t + 0.2);
        });
      } catch {}
    }, mensagem)
    .catch(() => {});
}
