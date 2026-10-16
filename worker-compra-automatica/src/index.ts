import { config } from "./config.js";
import { supabase } from "./supabaseClient.js";
import { CAMPOS_PEDIDO, DOMINIO_SUPORTADO, MAX_TENTATIVAS, processarPedido } from "./processar.js";
import type { PedidoRow } from "./types.js";

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
