function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return value;
}

export const config = {
  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  storeLoginEmail: required("STORE_LOGIN_EMAIL"),
  storeLoginSenha: required("STORE_LOGIN_SENHA"),
  storeCardCvv: process.env.STORE_CARD_CVV || null,
  compraModo: (process.env.COMPRA_MODO === "automatico" ? "automatico" : "validacao") as
    | "automatico"
    | "validacao",
  valorMaximoCompraAutomatica: Number(process.env.VALOR_MAXIMO_COMPRA_AUTOMATICA ?? 300),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 60000),
};
