export type AutomacaoStatus =
  | "pendente"
  | "processando"
  | "aguardando_aprovacao"
  | "aprovado"
  | "comprado"
  | "falhou";

export interface PedidoRow {
  id: string;
  produto_nome: string;
  produto_url_oficial: string | null;
  quantidade: number;
  valor_pago: number;
  cliente_nome: string;
  cliente_cpf: string;
  cliente_telefone: string | null;
  cep: string | null;
  rua: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  cidade: string | null;
  estado: string | null;
  automacao_status: AutomacaoStatus;
  automacao_tentativas: number;
}
