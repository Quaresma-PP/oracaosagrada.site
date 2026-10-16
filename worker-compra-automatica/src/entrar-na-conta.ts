// Abre o navegador do robô (mesmo perfil da fila assistida) na página de
// login da loja do Santuário. A pessoa entra na conta uma vez e fecha a
// janela; daí pra frente o "Comprar pedidos" já abre logado.
import { chromium } from "playwright";
import { PERFIL_DIR } from "./perfil.js";

async function main() {
  const context = await chromium.launchPersistentContext(PERFIL_DIR, {
    headless: false,
    locale: "pt-BR",
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://www.lojasantuarionacional.com.br/login", { waitUntil: "domcontentloaded" });

  console.log("\nEntre na conta da loja do Santuário (ogrupolod@gmail.com) na janela que abriu.");
  console.log("Depois de entrar, FECHE a janela do navegador — o login fica salvo pro robô.\n");

  await new Promise<void>((resolve) => context.on("close", () => resolve()));
  console.log("Pronto! O login foi salvo. Agora é só usar o \"Comprar pedidos\".");
}

main().catch((err) => {
  console.error("Erro:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
