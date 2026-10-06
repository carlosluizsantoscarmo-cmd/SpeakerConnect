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

- **Contratação:** a empresa pede orçamento, o palestrante envia o valor, a empresa aceita e paga pelo Mercado Pago. A plataforma fica com a comissão (`COMMISSION_PCT`, hoje 15%) e repassa o restante ao palestrante. Os repasses são feitos por você (Pix) e marcados no painel em **Pagamentos > Marcar repasse feito**.
- **Selo de verificado:** o palestrante aprovado paga pelo app (`VERIFIED_PRICE_CENTS`, hoje R$ 99,90) e o selo vale `VERIFIED_DAYS` dias (hoje 365; use 0 para nunca vencer).
- O telefone e o e-mail das duas partes só aparecem **depois do pagamento**, para que ninguém feche negócio por fora.
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
   - `MP_ACCESS_TOKEN` (Access Token de produção do Mercado Pago, o **novo**, renovado)
   - `MP_WEBHOOK_SECRET` (passo 4)
   - `RESEND_API_KEY`
   - `NOTIFY_SECRET` (invente uma senha com 20 caracteres ou mais)
3. **Domínio:** em **Settings > Domains & Routes > Add > Custom domain**, adicione o domínio e o `www`, como fizemos no Resolvo Já.

### 4. Mercado Pago
1. Em **Suas integrações > sua aplicação > Webhooks**, configure o modo produtivo com a URL `https://SEU-DOMINIO/api/mp-webhook` e marque o evento **Pagamentos**.
2. Copie a **assinatura secreta** gerada e salve no Cloudflare como `MP_WEBHOOK_SECRET`.

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
4. Como palestrante, envie uma proposta de R$ 5,00. Como empresa, aceite e pague de verdade (Pix).
5. Confira: o pedido vira "Contratado", os contatos aparecem e o pagamento entra no painel com comissão e repasse. Depois, reembolse pelo Mercado Pago.

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
