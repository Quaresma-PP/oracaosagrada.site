function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return value;
}

export const config = {
  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  storeLoginEmail: required("STORE_LOGIN_EMAIL"),
  // Só usada se a loja pedir senha no checkout (até agora não pediu).
  storeLoginSenha: process.env.STORE_LOGIN_SENHA || null,
  storeCardCvv: process.env.STORE_CARD_CVV || null,
  // Cartão digitado no checkout quando a conta não mostra cartão salvo.
  // Validade no formato MM/AA. Só em variável de ambiente — nunca no código.
  storeCardNumero: (process.env.STORE_CARD_NUMERO || "").replace(/\D/g, "") || null,
  storeCardNome: process.env.STORE_CARD_NOME || null,
  storeCardValidade: process.env.STORE_CARD_VALIDADE || null,
  // CPF do titular do cartão — o formulário de cartão novo pede.
  storeCardCpf: (process.env.STORE_CARD_CPF || "").replace(/\D/g, "") || null,
  compraModo: (process.env.COMPRA_MODO === "automatico" ? "automatico" : "validacao") as
    | "automatico"
    | "validacao",
  valorMaximoCompraAutomatica: Number(process.env.VALOR_MAXIMO_COMPRA_AUTOMATICA ?? 300),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 60000),
};
