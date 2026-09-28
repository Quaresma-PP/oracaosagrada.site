# Worker de compra automática — Loja Santuário Nacional

Roda separado do resto do projeto (não é Supabase Edge Function — precisa
de Chromium via Playwright, que não roda no runtime do Supabase). Fica de
olho na tabela `pedidos`: todo pedido com `status = 'pago'` e
`automacao_status` em `pendente` ou `aprovado` é pego pra tentar comprar
sozinho na loja oficial.

## ⚠️ Antes de usar em produção — valide os seletores

Escrevi a automação (`src/comprador.ts`) com base na estrutura comum de
lojas VTEX FastStore, mas **não tenho como abrir um navegador de verdade
contra o site real** a partir daqui pra confirmar os textos exatos dos
botões, campos e mensagens. Cada etapa do fluxo (`passo1...` até
`passo6...`) tem uma chance de precisar de ajuste fino.

Passo a passo pra validar:

```bash
npm install
npm run codegen
```

Isso abre o Playwright Inspector navegando no site. Faça manualmente, na
conta de teste:
1. Abrir um produto e adicionar à sacola
2. Ir pro carrinho / finalizar compra
3. Fazer login
4. Adicionar um endereço novo
5. Escolher frete
6. Selecionar o cartão salvo
7. Finalizar a compra (ou parar antes, se for só validar)

O Inspector mostra o seletor exato de cada elemento clicado — compare com
o que está em `comprador.ts` e ajuste os textos nas expressões regulares
(`getByRole`, `getByText`, `getByPlaceholder`, etc.) pra bater com o que
você viu.

## Modo de validação (recomendado pra começar)

Com `COMPRA_MODO=validacao` (padrão), o worker faz todo o fluxo até deixar
o carrinho pronto pra pagar, tira um print, e para — marca o pedido como
`aguardando_aprovacao`. Você revisa no painel `/admin` (produto certo,
endereço certo, valor certo) e clica em "Aprovar e finalizar pagamento".
Só depois disso o worker volta e realmente paga.

Quando estiver confiante que está pegando os dados certos em vários
pedidos seguidos, troque pra `COMPRA_MODO=automatico` — mesmo assim, o
`VALOR_MAXIMO_COMPRA_AUTOMATICA` continua sendo respeitado como trava de
segurança: qualquer carrinho acima desse valor sempre para pra aprovação
manual.

## Rodando local

```bash
cp .env.example .env   # preencha com os valores reais
npm install
npx playwright install chromium
npm run dev
```

## Deploy no Railway

1. Crie um novo projeto no Railway apontando pra esta pasta
   (`worker-compra-automatica/`) do repositório — o Railway detecta o
   `Dockerfile` automaticamente.
2. Configure as variáveis de ambiente do `.env.example` direto no painel
   do Railway (nunca commitar `.env` com valores reais).
3. Deploy. O processo fica rodando indefinidamente (loop de polling), sem
   precisar de porta HTTP exposta — é um worker, não um servidor web.

## Segurança

- O login e a senha da conta da loja, e o CVV (se precisar), ficam só nas
  variáveis de ambiente do Railway — nunca no código nem no banco.
- Recomendo fortemente usar um cartão dedicado só pra esse robô, com
  limite baixo, justamente pra limitar o estrago se algo sair errado ou
  vazar.
- O worker usa a `SUPABASE_SERVICE_ROLE_KEY`, que ignora RLS — mantenha
  essa chave só aqui e no `webhook-payt`, nunca no frontend.
