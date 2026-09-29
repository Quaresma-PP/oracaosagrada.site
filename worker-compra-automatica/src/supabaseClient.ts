import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { config } from "./config.js";

// A imagem base do Playwright roda Node 20, que não tem WebSocket nativo
// (só a partir do Node 22) — o cliente realtime do supabase-js precisa de
// um polyfill mesmo sem usarmos realtime de verdade aqui.
export const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { persistSession: false },
  realtime: { transport: WebSocket as never },
});
