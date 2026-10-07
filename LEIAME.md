# SpeakerConnect — como colocar no ar

Mesmo modelo do Resolvo Já: site e app no **Cloudflare** (publicação automática pelo GitHub), dados e login no **Supabase**, pagamentos no **Mercado Pago** e e-mails pelo **Resend**. Não há servidor para cuidar.

```
public/index.html          site: abertura, catálogo de palestrantes, como funciona, perguntas
public/palestrante.html    página pública de cada palestrante (?id=...)
public/app/                app (PWA) da empresa e do palestrante: pedidos, propostas, mensagens, pagamento
public/equipe/             painel da equipe: aprovar palestrantes, pedidos, pagamentos e repasses, temas
public/config.js           endereço e chave PÚBLICA do Supabase, WhatsApp e e-mail de contato
worker.js                  servidor: pagamentos (selo e contratação), confirmação do Mercado Pago, e-mails, exclusão de conta
supabase/schema.sql        banco de dados completo, com as regras de segurança
test/                      testes (servidor e banco)
```

## Como funciona o dinheiro

- **Contratação (Split, como no Resolvo Já):** o palestrante conecta a conta dele do Mercado Pago no app. A empresa paga e o valor cai **direto na conta do palestrante**; o Mercado Pago separa sozinho a comissão da plataforma (`COMMISSION_PCT`, hoje 20%) e manda para a conta do SpeakerConnect. Não há repasse manual, e a plataforma só fatura a comissão. Sem a conta conectada, o palestrante não consegue enviar proposta.
- **Devolução:** no painel, **Pagamentos > Devolver** faz o reembolso integral pelo Mercado Pago (o valor sai da conta do palestrante e a comissão volta junto) e cancela o pedido. Como a palestra costuma ser marcada com semanas de antecedência, a cobrança é feita na hora (a reserva no cartão do Resolvo Já dura só alguns dias).
- **Selo de verificado:** o palestrante aprovado paga pelo app (`VERIFIED_PRICE_CENTS`, hoje R$ 199,00) e o selo vale `VERIFIED_DAYS` dias (hoje 365; use 0 para nunca vencer).
- O telefone e o e-mail das duas partes só aparecem **depois do pagamento**, para que ninguém feche negócio por fora.
- **Documento e termo do palestrante:** para enviar o perfil para análise, o palestrante precisa mandar a foto do documento (RG, CNH, RNE ou passaporte) e aceitar o `termo-palestrante.html`. O documento fica na pasta privada `documentos` do Supabase, visível só para ele e para a equipe (painel > Palestrantes > ver frente/verso), e é apagado quando a conta é excluída.
- O valor cobrado vem sempre do banco de dados, nunca do navegador. O pagamento só é aceito depois de conferido na API do Mercado Pago (valor e moeda).

## Passo a passo

### 1. Supabase (banco e login)
1. Em supabase.com, crie um projeto **novo** (não use o antigo do Horizons). Região: São Paulo.
2. **Database > Extensions:** ative `pg_net` (é o que manda os avisos por e-mail).
3. **SQL Editor > New query:** cole todo o arquivo `supabase/schema.sql` e clique em **Run**. Pode rodar de novo quando houver atualização; ele não apaga dados.
4. **Authentication > URL Configuration:** em *Site URL*, coloque `https://SEU-DOMINIO/app/`. Em *Redirect URLs*, adicione `https://SEU-DOMINIO/app/` e o endereço `...workers.dev/app/`.
5. **Authentication > Emails > SMTP Settings:** use o Resend, como no Resolvo Já (host `smtp.resend.com`, porta 465, usuário `resend`, senha = chave do Resend, remetente do seu domínio verificado).
6. **Project Settings > API Keys:** copie a **URL do projeto**, a chave **pública** (publishable/anon) e a chave **secreta** (`service_role`, ou a *Secret key*). A secreta nunca vai para o site nem para o GitHub.

### 2. Arquivos com os seus dados
No GitHub, clique no arquivo e no lápis (editar):
- `public/config.js`: URL do Supabase, chave pública, WhatsApp de suporte e e-mail de contato.
- `wrangler.jsonc`: `SITE_URL`, `ALLOWED_ORIGINS`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `MAIL_FROM`, `NOTIFY_EMAIL`, comissão e selo.
- Se o domínio não for `speakerconnect.com.br`, troque também em `public/robots.txt`, `public/sitemap.xml` e na linha `canonical` de `public/index.html`.

### 3. Cloudflare (site e servidor)
1. **Workers & Pages > Create > Import a repository** e escolha `SpeakerConnect`. Build vazio; deploy `npx wrangler deploy`.
2. Depois do primeiro deploy, em **Settings > Variables and Secrets**, adicione como **Secret**:
   - `SUPABASE_SERVICE_ROLE_KEY` (chave secreta do Supabase)
   - `MP_ACCESS_TOKEN` (Access Token de produção da aplicação do Mercado Pago)
   - `MP_PUBLIC_KEY` (Public Key de produção; pode ser texto em vez de Secret)
   - `MP_CLIENT_ID` e `MP_CLIENT_SECRET` (da mesma aplicação, passo 4)
   - `MP_TOKEN_KEY` (invente uma senha com 32 caracteres ou mais; ela cifra as contas dos palestrantes. Não troque depois, senão os palestrantes precisam conectar de novo)
   - `MP_WEBHOOK_SECRET` (passo 4)
   - `RESEND_API_KEY`
   - `NOTIFY_SECRET` (invente uma senha com 20 caracteres ou mais)
3. **Domínio:** em **Settings > Domains & Routes > Add > Custom domain**, adicione o domínio e o `www`, como fizemos no Resolvo Já.

### 4. Mercado Pago
1. Em **mercadopago.com.br/developers > Suas integrações > Criar aplicação**: nome `SpeakerConnect`, pagamentos online, desenvolvimento próprio, produto **Checkout Transparente** (o pagamento acontece dentro do app, com Pix e cartão, como no Resolvo Já). Se perguntar se é marketplace, responda **sim** (o Split depende disso).
2. Em **Credenciais de produção**, copie para o Cloudflare o **Access Token** (`MP_ACCESS_TOKEN`), o **Client ID** (`MP_CLIENT_ID`) e o **Client Secret** (`MP_CLIENT_SECRET`), como Secrets. A **Public Key** vai como variável de texto `MP_PUBLIC_KEY` (ela é pública).
3. Em **Editar aplicação** (ou **Configurações > OAuth / URLs de redirecionamento**), adicione a URL `https://SEU-DOMINIO/api/mp-oauth/callback`. É para onde o palestrante volta depois de conectar a conta.
4. Em **Webhooks > Configurar notificações**, no modo produtivo, use a URL `https://SEU-DOMINIO/api/mp-webhook` e marque o evento **Pagamentos**.
5. Copie a **assinatura secreta** gerada e salve no Cloudflare como `MP_WEBHOOK_SECRET`.

### 5. Ligar os avisos por e-mail
No Supabase, **SQL Editor**, rode (com o seu domínio e a mesma senha do `NOTIFY_SECRET`):
```sql
insert into private.settings values ('notify_url', 'https://SEU-DOMINIO/api/aviso')
  on conflict (key) do update set value = excluded.value;
insert into private.settings values ('notify_secret', 'A-MESMA-SENHA-DO-NOTIFY_SECRET')
  on conflict (key) do update set value = excluded.value;
```

### 6. Sua conta da equipe
1. Abra `https://SEU-DOMINIO/app/`, crie sua conta e confirme o e-mail.
2. No **SQL Editor**, rode: `update public.profiles set role = 'admin' where email = 'seu-email@...';`
3. Entre em `https://SEU-DOMINIO/equipe/`.

### 7. Teste completo antes de divulgar
1. Crie uma conta de **palestrante** (outro e-mail), preencha o perfil e envie para análise. Você deve receber o e-mail "Perfil para aprovar".
2. No painel, aprove. O perfil aparece no site.
3. Crie uma conta de **empresa**, abra o perfil no site e peça um orçamento. O palestrante recebe o e-mail.
4. Como palestrante, conecte a conta do Mercado Pago (use uma conta **diferente** da conta da plataforma; o Mercado Pago não deixa pagar e receber na mesma conta) e envie uma proposta de R$ 5,00. Como empresa, aceite e pague de verdade por Pix, também com uma conta diferente.
5. Confira: o pedido vira "Contratado", os contatos aparecem, o valor menos a comissão entra na conta do palestrante e a comissão na conta da plataforma. Depois, use **Devolver** no painel.

## Segurança: o que mudou em relação ao site do Horizons
- Login do próprio Supabase (senhas nunca passam pelo navegador em texto, nem ficam numa tabela aberta).
- Nenhuma chave secreta no código do site. O token do Mercado Pago fica só no Cloudflare.
- Cada pessoa só lê e altera o que é dela; ninguém se aprova, se dá selo, vira administrador ou marca algo como pago. Isso está testado em `test/db.test.sql` (71 verificações).
- Não existe mais a função que criava administradores para qualquer pessoa.

## Testes (para quem for mexer no código)
- `npm test`: servidor (pagamentos, webhook, e-mails, exclusão de conta), sem internet.
- `sh test/run-db-tests.sh`: banco, com um Postgres local que imita o Supabase.
- `python3 test/shots.py`: abre as telas num navegador com dados de mentira.

## O que eu testei e o que não testei
- Testado aqui: as regras do banco num Postgres 16 local; o servidor com Supabase, Mercado Pago e Resend simulados; site, app e painel no navegador com dados de mentira (cadastro, pedido, proposta, aceite, pagamento, mensagens, aprovação, repasse).
- **Não testado:** Supabase, Cloudflare e Mercado Pago de verdade (não tenho acesso às contas daqui). Por isso o passo 7 é importante.
