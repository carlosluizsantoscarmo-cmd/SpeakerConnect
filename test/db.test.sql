-- Testes das regras do banco. Roda com: test/run-db-tests.sh
\set ON_ERROR_STOP 1
\set QUIET 1
create schema tst;
grant usage on schema tst to public;
create table tst.results (n serial, name text, ok boolean, detail text);
grant all on tst.results to public; grant all on sequence tst.results_n_seq to public;

-- espera que o comando funcione
create function tst.ok(name text, q text) returns void language plpgsql as $$
begin
  begin execute q; insert into tst.results(name, ok) values (name, true);
  exception when others then insert into tst.results(name, ok, detail) values (name, false, sqlerrm); end;
end $$;
-- espera que o comando seja barrado (erro ou nenhuma linha afetada)
create function tst.no(name text, q text) returns void language plpgsql as $$
declare n int;
begin
  begin execute q; get diagnostics n = row_count;
    insert into tst.results(name, ok, detail) values (name, n = 0, case when n > 0 then 'deveria ter sido barrado; linhas: ' || n end);
  exception when others then insert into tst.results(name, ok, detail) values (name, true, sqlerrm); end;
end $$;
-- espera que a consulta devolva exatamente "expected"
create function tst.eq(name text, q text, expected text) returns void language plpgsql as $$
declare got text;
begin
  begin execute q into got;
    insert into tst.results(name, ok, detail) values (name, got is not distinct from expected, 'obtido: ' || coalesce(got, 'null') || ' / esperado: ' || coalesce(expected, 'null'));
  exception when others then insert into tst.results(name, ok, detail) values (name, false, sqlerrm); end;
end $$;

-- ---------- usuários ----------
insert into auth.users (id, email, raw_user_meta_data) values
 ('00000000-0000-0000-0000-00000000000a', 'equipe@x.com',   '{"role":"admin","name":"Equipe"}'),
 ('00000000-0000-0000-0000-000000000001', 'ana@x.com',      '{"role":"speaker","name":"Ana Palestrante","phone":"27999990001","terms_version":"v1"}'),
 ('00000000-0000-0000-0000-000000000002', 'beto@x.com',     '{"role":"speaker","name":"Beto Palestrante"}'),
 ('00000000-0000-0000-0000-000000000003', 'rh@empresa.com', '{"role":"company","name":"Carla RH","company_name":"Empresa Boa","phone":"27999990003"}'),
 ('00000000-0000-0000-0000-000000000004', 'rh@outra.com',   '{"name":"Davi"}');
select tst.eq('cadastro com role admin vira empresa', $$select role from profiles where id='00000000-0000-0000-0000-00000000000a'$$, 'company');
update profiles set role = 'admin' where email = 'equipe@x.com';  -- feito pelo SQL Editor (postgres)
select tst.eq('sem role vira empresa', $$select role from profiles where email='rh@outra.com'$$, 'company');
select tst.eq('empresa criada com nome', $$select company_name from companies where id='00000000-0000-0000-0000-000000000003'$$, 'Empresa Boa');
select tst.eq('palestrante criado como rascunho', $$select status from speakers where id='00000000-0000-0000-0000-000000000001'$$, 'draft');
select tst.eq('aceite dos termos registrado', $$select (terms_accepted_at is not null)::text from profiles where email='ana@x.com'$$, 'true');

-- ---------- visitante (anon) ----------
set role anon;
select tst.eq('visitante não vê rascunhos', $$select count(*)::text from speakers$$, '0');
select tst.no('visitante não lê perfis', $$select * from profiles$$);
select tst.no('visitante não lê pagamentos', $$select * from payments$$);
select tst.eq('visitante lê categorias', $$select (count(*) > 5)::text from categories$$, 'true');
select tst.no('visitante não cria pedido', $$insert into quotes(company_id, speaker_id, title) values ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','x x x')$$);
reset role;

-- ---------- Ana (palestrante) ----------
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
select tst.no('palestrante não se aprova sozinha', $$update speakers set status='approved' where id=auth.uid()$$);
select tst.no('palestrante não se dá selo', $$update speakers set verified_until = now() + interval '1 year' where id=auth.uid()$$);
select tst.no('palestrante não vira admin', $$update profiles set role='admin' where id=auth.uid()$$);
select tst.no('perfil incompleto não vai para análise', $$update speakers set status='pending' where id=auth.uid()$$);
select tst.no('categoria inexistente barrada', $$update speakers set categories='{Astrologia}' where id=auth.uid()$$);
select tst.ok('palestrante completa o perfil', $$update speakers set headline='Liderança que gera resultado', bio=repeat('Experiência em grandes empresas. ', 4), categories='{Liderança,Vendas}', city='Vitória', uf='ES', fee_from_cents=500000 where id=auth.uid()$$);
select tst.no('sem documento não vai para análise', $$update speakers set status='pending' where id=auth.uid()$$);
select tst.no('documento na pasta de outro é barrado', $$insert into speaker_documents(speaker_id, doc_type, front_path) values (auth.uid(), 'RG', '00000000-0000-0000-0000-000000000002/rg.jpg')$$);
select tst.no('não cria documento em nome de outro', $$insert into speaker_documents(speaker_id, doc_type, front_path) values ('00000000-0000-0000-0000-000000000002', 'RG', '00000000-0000-0000-0000-000000000002/rg.jpg')$$);
select tst.ok('palestrante envia o documento', $$insert into speaker_documents(speaker_id, doc_type, front_path, back_path) values (auth.uid(), 'CNH', auth.uid()::text || '/doc-frente.jpg', auth.uid()::text || '/doc-verso.jpg')$$);
select tst.no('sem aceitar o termo não vai para análise', $$update speakers set status='pending' where id=auth.uid()$$);
select tst.ok('palestrante aceita o termo', $$update speaker_documents set terms_version='2026-10-v1' where speaker_id=auth.uid()$$);
select tst.eq('data do envio e do aceite gravadas', $$select (sent_at is not null and terms_at is not null)::text from speaker_documents$$, 'true');
select tst.ok('documento na própria pasta (Storage)', $$insert into storage.objects(bucket_id, name) values ('documentos', auth.uid()::text || '/doc-frente.jpg')$$);
select tst.no('documento na pasta de outro (Storage)', $$insert into storage.objects(bucket_id, name) values ('documentos', '00000000-0000-0000-0000-000000000002/x.jpg')$$);
select tst.ok('palestrante envia para análise', $$update speakers set status='pending' where id=auth.uid()$$);
select tst.no('palestrante não edita outro perfil', $$update speakers set bio='hackeado' where id='00000000-0000-0000-0000-000000000002'$$);
select tst.eq('palestrante não vê outros perfis', $$select count(*)::text from profiles$$, '1');
select tst.ok('foto na própria pasta', $$insert into storage.objects(bucket_id, name) values ('fotos', auth.uid()::text || '/foto.jpg')$$);
select tst.no('foto na pasta de outro', $$insert into storage.objects(bucket_id, name) values ('fotos', '00000000-0000-0000-0000-000000000002/foto.jpg')$$);
reset role;
select tst.eq('aviso de perfil para análise', $$select count(*)::text from net.calls$$, '0'); -- sem configuração, não envia
insert into private.settings values ('notify_url', 'https://exemplo/api/aviso'), ('notify_secret', 'segredo-de-teste-123456');

-- ---------- empresa tenta pedir antes da aprovação ----------
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', false);
select tst.no('não pede orçamento a perfil não aprovado', $$insert into quotes(company_id, speaker_id, title) values (auth.uid(),'00000000-0000-0000-0000-000000000001','Palestra de abertura')$$);
reset role;

-- ---------- equipe aprova ----------
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select tst.ok('equipe aprova palestrante', $$update speakers set status='approved' where id='00000000-0000-0000-0000-000000000001'$$);
select tst.no('empresa com telefone no nome', $$update companies set company_name='Empresa 27 99999-0000' where id='00000000-0000-0000-0000-000000000003'$$);
select tst.eq('equipe vê todos os perfis', $$select count(*)::text from profiles$$, '5');
select tst.eq('equipe vê o documento', $$select doc_type from speaker_documents$$, 'CNH');
select tst.eq('equipe abre o arquivo do documento', $$select count(*)::text from storage.objects where bucket_id='documentos'$$, '1');
select tst.ok('equipe cria categoria', $$insert into categories(name) values ('Astrologia')$$);
reset role;
select tst.eq('aviso de aprovação disparado', $$select body->>'type' from net.calls order by ctid desc limit 1$$, 'perfil_aprovado');
select tst.eq('aviso leva a senha', $$select headers->>'x-sc-secret' from net.calls limit 1$$, 'segredo-de-teste-123456');

select set_config('request.jwt.claim.sub', '', false);
set role anon;
select tst.no('visitante não vê documentos', $$select * from speaker_documents$$);
select tst.eq('visitante vê só o aprovado', $$select string_agg(public_name, ',') from speakers$$, 'Ana Palestrante');
reset role;

-- ---------- Ana tenta se passar por empresa ----------
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
select tst.no('palestrante não pede em nome da empresa', $$insert into quotes(company_id, speaker_id, title) values ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','Falso')$$);
reset role;

-- ---------- empresa pede orçamento ----------
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', false);
select tst.no('empresa não manda pedido já pago', $$insert into quotes(company_id, speaker_id, title, status) values (auth.uid(),'00000000-0000-0000-0000-000000000001','Palestra','paid')$$);
select tst.no('empresa não define valor', $$insert into quotes(company_id, speaker_id, title, amount_cents) values (auth.uid(),'00000000-0000-0000-0000-000000000001','Palestra', 100)$$);
select tst.ok('empresa pede orçamento', $$insert into quotes(id, company_id, speaker_id, title, event_date, city, uf, audience, message) values ('10000000-0000-0000-0000-000000000001', auth.uid(),'00000000-0000-0000-0000-000000000001','SIPAT 2026','2026-11-20','Serra','ES',200,'Turno da manhã')$$);
select tst.eq('nome da empresa preenchido sozinho', $$select company_name from quotes$$, 'Empresa Boa');
select tst.no('empresa não aceita sem proposta', $$update quotes set status='accepted'$$);
select tst.ok('empresa ajusta o pedido antes da proposta', $$update quotes set audience=250$$);
select tst.ok('empresa manda mensagem', $$insert into quote_messages(quote_id, body) values ('10000000-0000-0000-0000-000000000001','Olá, Ana!')$$);
-- sem troca de contato antes do pagamento
select tst.no('chat barra telefone', $$insert into quote_messages(quote_id, body) values ('10000000-0000-0000-0000-000000000001','me chama no 27 99613-3207')$$);
select tst.no('chat barra telefone com pontos', $$insert into quote_messages(quote_id, body) values ('10000000-0000-0000-0000-000000000001','(27) 9.9.6.1.3-3207')$$);
select tst.no('chat barra telefone por extenso', $$insert into quote_messages(quote_id, body) values ('10000000-0000-0000-0000-000000000001','nove nove seis um tres tres dois zero sete')$$);
select tst.no('chat barra telefone fixo', $$insert into quote_messages(quote_id, body) values ('10000000-0000-0000-0000-000000000001','liga no 3225-8687')$$);
select tst.no('chat barra e-mail', $$insert into quote_messages(quote_id, body) values ('10000000-0000-0000-0000-000000000001','joao.silva@empresa.com.br')$$);
select tst.no('chat barra e-mail disfarçado', $$insert into quote_messages(quote_id, body) values ('10000000-0000-0000-0000-000000000001','joao arroba gmail ponto com')$$);
select tst.no('chat barra @ de rede social', $$insert into quote_messages(quote_id, body) values ('10000000-0000-0000-0000-000000000001','me segue @joaosilva')$$);
select tst.no('chat barra link', $$insert into quote_messages(quote_id, body) values ('10000000-0000-0000-0000-000000000001','veja www.empresa.com.br')$$);
select tst.no('chat barra dominio solto', $$insert into quote_messages(quote_id, body) values ('10000000-0000-0000-0000-000000000001','site empresaboa.com')$$);
select tst.no('chat barra whatsapp', $$insert into quote_messages(quote_id, body) values ('10000000-0000-0000-0000-000000000001','me chama no zap')$$);
select tst.no('chat barra rede social citada', $$insert into quote_messages(quote_id, body) values ('10000000-0000-0000-0000-000000000001','me procura no insta')$$);
select tst.no('chat barra pagamento por fora', $$insert into quote_messages(quote_id, body) values ('10000000-0000-0000-0000-000000000001','podemos acertar por fora?')$$);
select tst.ok('chat aceita mensagem normal com data e números', $$insert into quote_messages(quote_id, body) values ('10000000-0000-0000-0000-000000000001','O evento é dia 20/11/2026 às 14h, para 250 pessoas, 2 horas. Orçamento até R$ 8.000,00. Pode ser por Pix pela plataforma?')$$);
select tst.ok('chat aceita citar o site da plataforma', $$insert into quote_messages(quote_id, body) values ('10000000-0000-0000-0000-000000000001','vi seu perfil no speakerconnect.com.br')$$);
select tst.no('pedido com telefone na mensagem', $$update quotes set message='ligar 27 99999-0000'$$);
select tst.ok('registra tentativa', $$select log_contact_attempt('chat', 'me chama no zap', '10000000-0000-0000-0000-000000000001')$$);
select tst.ok('não registra texto limpo', $$select log_contact_attempt('chat', 'bom dia', '10000000-0000-0000-0000-000000000001')$$);
select tst.eq('empresa não lê as tentativas', $$select count(*)::text from contact_attempts$$, '0');
select tst.no('mensagem com remetente falso', $$insert into quote_messages(quote_id, sender_id, body) values ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','Sou a Ana')$$);
select tst.eq('contato ainda escondido', $$select count(*)::text from quote_contacts('10000000-0000-0000-0000-000000000001')$$, '0');
reset role;
select tst.eq('aviso de pedido novo', $$select count(*)::text from net.calls where body->>'type'='pedido_novo'$$, '1');

-- ---------- outra empresa e outro palestrante não enxergam ----------
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000004', false);
select tst.eq('empresa não vê documentos', $$select count(*)::text from speaker_documents$$, '0');
select tst.eq('empresa não vê arquivos de documento', $$select count(*)::text from storage.objects where bucket_id='documentos'$$, '0');
select tst.eq('outra empresa não vê o pedido', $$select count(*)::text from quotes$$, '0');
select tst.eq('outra empresa não vê mensagens', $$select count(*)::text from quote_messages$$, '0');
select tst.no('outra empresa não muda o pedido', $$update quotes set status='cancelled'$$);
select tst.no('outra empresa não escreve na conversa', $$insert into quote_messages(quote_id, body) values ('10000000-0000-0000-0000-000000000001','oi')$$);
reset role;
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', false);
select tst.eq('outro palestrante não vê o pedido', $$select count(*)::text from quotes$$, '0');
select tst.eq('outro palestrante não vê a empresa', $$select count(*)::text from companies$$, '0');
reset role;

-- ---------- Ana responde ----------
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
select tst.eq('palestrante não vê site nem CNPJ da empresa', $$select count(*)::text from companies$$, '0');
select tst.eq('palestrante vê o nome da empresa no pedido', $$select company_name from quotes$$, 'Empresa Boa');
select tst.no('proposta com telefone', $$update quotes set status='proposed', amount_cents=800000, speaker_note='me liga 27 99999-0001'$$);
select tst.no('chat do palestrante barra e-mail', $$insert into quote_messages(quote_id, body) values ('10000000-0000-0000-0000-000000000001','ana@palestras.com')$$);
select tst.no('perfil público barra e-mail na bio', $$update speakers set bio = bio || ' Contato: ana@palestras.com' where id=auth.uid()$$);
select tst.no('perfil público barra telefone na frase', $$update speakers set headline='Liderança - 27 99999-0001' where id=auth.uid()$$);
select tst.ok('perfil aceita palestra sobre Instagram', $$update speakers set topics='Instagram para negócios' where id=auth.uid()$$);
select tst.ok('rede social não é publicada', $$update speakers set instagram='@ana', linkedin='https://linkedin.com/in/ana' where id=auth.uid()$$);
select tst.no('vídeo fora do YouTube/Vimeo', $$update speakers set video_url='https://wa.me/5527999990001' where id=auth.uid()$$);
select tst.ok('vídeo do YouTube', $$update speakers set video_url='https://www.youtube.com/watch?v=abcdefghijk' where id=auth.uid()$$);
select tst.no('foto de fora do app', $$update speakers set photo_url='https://exemplo.com/eu.jpg' where id=auth.uid()$$);
select tst.eq('rede social fica vazia', $$select coalesce(instagram,'') || coalesce(linkedin,'') from speakers where id=auth.uid()$$, '');
select tst.no('palestrante não muda a data do evento', $$update quotes set event_date='2026-12-01'$$);
select tst.no('palestrante não marca como pago', $$update quotes set status='paid'$$);
select tst.no('proposta sem valor', $$update quotes set status='proposed'$$);
select tst.ok('palestrante manda proposta', $$update quotes set status='proposed', amount_cents=800000, speaker_note='Inclui material'$$);
select tst.eq('data da proposta registrada', $$select (proposed_at is not null)::text from quotes$$, 'true');
reset role;

-- ---------- empresa aceita ----------
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', false);
select tst.no('empresa não baixa o valor', $$update quotes set amount_cents=100$$);
select tst.no('empresa não muda o evento depois da proposta', $$update quotes set audience=10$$);
select tst.no('empresa não marca como pago', $$update quotes set status='paid'$$);
select tst.ok('empresa aceita a proposta', $$update quotes set status='accepted'$$);
select tst.no('palestrante não muda valor depois do aceite', $$update quotes set amount_cents=1$$);
reset role;
select tst.eq('aviso de proposta aceita', $$select count(*)::text from net.calls where body->>'type'='proposta_aceita'$$, '1');

-- ---------- servidor confirma pagamento ----------
set role service_role; select set_config('request.jwt.claim.role', 'service_role', false); select set_config('request.jwt.claim.sub', '', false);
select tst.ok('servidor marca como pago', $$update quotes set status='paid', paid_at=now()$$);
select tst.ok('servidor grava pagamento', $$insert into payments(kind, user_id, quote_id, speaker_id, amount_cents, commission_cents, payout_cents, status) values ('quote','00000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',800000,120000,680000,'paid')$$);
select tst.ok('servidor dá o selo', $$update speakers set verified_until=now()+interval '1 year' where id='00000000-0000-0000-0000-000000000001'$$);
select set_config('request.jwt.claim.role', '', false);
reset role;

set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', false);
select tst.eq('contato liberado após pagamento', $$select speaker_phone from quote_contacts('10000000-0000-0000-0000-000000000001')$$, '27999990001');
select tst.ok('depois do pagamento o chat fica livre', $$insert into quote_messages(quote_id, body) values ('10000000-0000-0000-0000-000000000001','meu whats é 27 99999-0000')$$);
select tst.eq('empresa vê o próprio pagamento', $$select count(*)::text from payments$$, '1');
select tst.no('empresa não altera pagamento', $$update payments set status='refunded'$$);
select tst.ok('empresa marca evento como realizado', $$update quotes set status='done'$$);
reset role;
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
select tst.eq('palestrante vê o pagamento da contratação', $$select payout_cents::text from payments$$, '680000');
select tst.eq('palestrante vê contato da empresa', $$select company_phone from quote_contacts('10000000-0000-0000-0000-000000000001')$$, '27999990003');
reset role;
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', false);
select tst.eq('outro palestrante não vê contato', $$select count(*)::text from quote_contacts('10000000-0000-0000-0000-000000000001')$$, '0');
select tst.eq('outro palestrante não vê pagamentos', $$select count(*)::text from payments$$, '0');
reset role;
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select tst.ok('equipe marca repasse feito', $$update payments set payout_done_at=now()$$);
reset role;

-- ---------- Split: contas do Mercado Pago ----------
set role service_role; select set_config('request.jwt.claim.role', 'service_role', false);
select tst.ok('servidor guarda conta MP', $$insert into speaker_mp_accounts(speaker_id, mp_user_id, access_token) values ('00000000-0000-0000-0000-000000000001','123','v1.cifrado')$$);
select set_config('request.jwt.claim.role', '', false);
reset role;
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
select tst.no('palestrante não lê o token guardado', $$select * from speaker_mp_accounts$$);
select tst.no('palestrante não troca a conta por SQL', $$insert into speaker_mp_accounts(speaker_id, mp_user_id, access_token) values (auth.uid(),'999','x')$$);
select tst.no('palestrante não marca pagamento como split', $$update payments set split = true$$);
reset role;
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000004', false);
select tst.eq('empresa sabe se o palestrante conectou', $$select mp_connected('00000000-0000-0000-0000-000000000001')::text$$, 'true');
select tst.eq('e se não conectou', $$select mp_connected('00000000-0000-0000-0000-000000000002')::text$$, 'false');
select tst.no('outra empresa não lê tokens', $$select * from speaker_mp_accounts$$);
reset role;
select set_config('request.jwt.claim.sub', '', false);
set role anon;
select tst.no('visitante não consulta conexão', $$select mp_connected('00000000-0000-0000-0000-000000000001')$$);
reset role;

set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select tst.eq('equipe vê as tentativas', $$select count(*)::text from contact_attempts$$, '1');
reset role;

-- ---------- Empresas Parceiras (logo) ----------
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', false);
select tst.no('empresa não usa logo de fora do app', $$update companies set logo_url='https://site.com/logo.png' where id=auth.uid()$$);
select tst.no('empresa não usa logo de outra pasta', $$update companies set logo_url='https://abc.supabase.co/storage/v1/object/public/fotos/00000000-0000-0000-0000-000000000004/x.png' where id=auth.uid()$$);
select tst.ok('empresa envia logo', $$update companies set logo_url='https://abc.supabase.co/storage/v1/object/public/fotos/00000000-0000-0000-0000-000000000003/logo-1.png' where id=auth.uid()$$);
select tst.eq('sem autorização a logo não vai para análise', $$select logo_status from companies where id=auth.uid()$$, 'none');
select tst.ok('empresa autoriza exibir', $$update companies set logo_consent=true where id=auth.uid()$$);
select tst.eq('com autorização vai para análise', $$select logo_status from companies where id=auth.uid()$$, 'pending');
select tst.ok('empresa tenta se aprovar', $$update companies set logo_status='approved' where id=auth.uid()$$);
select tst.eq('mas continua em análise', $$select logo_status from companies where id=auth.uid()$$, 'pending');
reset role;
set role anon;
select tst.eq('site não mostra logo em análise', $$select count(*)::text from partner_logos()$$, '0');
reset role;
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select tst.ok('equipe aprova a logo', $$update companies set logo_status='approved' where id='00000000-0000-0000-0000-000000000003'$$);
select tst.eq('aprovação registra a data', $$select (logo_reviewed_at is not null)::text from companies where id='00000000-0000-0000-0000-000000000003'$$, 'true');
reset role;
set role anon;
select tst.eq('site mostra logo aprovada', $$select company_name || '|' || logo_url from partner_logos()$$, 'Empresa Boa|https://abc.supabase.co/storage/v1/object/public/fotos/00000000-0000-0000-0000-000000000003/logo-1.png');
select tst.no('visitante não lê a tabela de empresas', $$select * from companies$$);
reset role;
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
select tst.eq('palestrante vê a lista pública', $$select count(*)::text from partner_logos()$$, '1');
select tst.eq('palestrante continua sem ler a tabela de empresas', $$select count(*)::text from companies$$, '0');
reset role;
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', false);
select tst.ok('empresa troca a logo', $$update companies set logo_url='https://abc.supabase.co/storage/v1/object/public/fotos/00000000-0000-0000-0000-000000000003/logo-2.png' where id=auth.uid()$$);
select tst.eq('logo nova volta para análise', $$select logo_status from companies where id=auth.uid()$$, 'pending');
reset role;
set role anon;
select tst.eq('logo nova não aparece antes de aprovar', $$select count(*)::text from partner_logos()$$, '0');
reset role;
update companies set logo_status='approved' where id='00000000-0000-0000-0000-000000000003';
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', false);
select tst.ok('empresa retira a autorização', $$update companies set logo_consent=false where id=auth.uid()$$);
select tst.eq('sem autorização sai do site', $$select logo_status from companies where id=auth.uid()$$, 'none');
reset role;
set role anon;
select tst.eq('site para de mostrar na hora', $$select count(*)::text from partner_logos()$$, '0');
reset role;

-- ---------- exclusão de conta mantém o registro financeiro ----------
delete from auth.users where id = '00000000-0000-0000-0000-000000000003';
select tst.eq('pagamento fica guardado após excluir conta', $$select count(*)::text from payments$$, '1');

\set QUIET 0
select name, detail from tst.results where not ok;
select count(*) filter (where ok) as passaram, count(*) filter (where not ok) as falharam from tst.results;
