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
select tst.eq('equipe vê todos os perfis', $$select count(*)::text from profiles$$, '5');
select tst.ok('equipe cria categoria', $$insert into categories(name) values ('Astrologia')$$);
reset role;
select tst.eq('aviso de aprovação disparado', $$select body->>'type' from net.calls order by ctid desc limit 1$$, 'perfil_aprovado');
select tst.eq('aviso leva a senha', $$select headers->>'x-sc-secret' from net.calls limit 1$$, 'segredo-de-teste-123456');

select set_config('request.jwt.claim.sub', '', false);
set role anon;
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
select tst.no('mensagem com remetente falso', $$insert into quote_messages(quote_id, sender_id, body) values ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','Sou a Ana')$$);
select tst.eq('contato ainda escondido', $$select count(*)::text from quote_contacts('10000000-0000-0000-0000-000000000001')$$, '0');
reset role;
select tst.eq('aviso de pedido novo', $$select count(*)::text from net.calls where body->>'type'='pedido_novo'$$, '1');

-- ---------- outra empresa e outro palestrante não enxergam ----------
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000004', false);
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
select tst.eq('palestrante vê a empresa que pediu', $$select company_name from companies$$, 'Empresa Boa');
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

-- ---------- exclusão de conta mantém o registro financeiro ----------
delete from auth.users where id = '00000000-0000-0000-0000-000000000003';
select tst.eq('pagamento fica guardado após excluir conta', $$select count(*)::text from payments$$, '1');

\set QUIET 0
select name, detail from tst.results where not ok;
select count(*) filter (where ok) as passaram, count(*) filter (where not ok) as falharam from tst.results;
