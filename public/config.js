// Configurações públicas do SpeakerConnect (site, app e painel da equipe).
// Só valores que podem ficar visíveis. NUNCA coloque aqui a chave "service_role" nem tokens do Mercado Pago.
window.SC = {
  // Supabase > Project Settings > API: "Project URL" e a chave pública ("publishable" ou "anon").
  supabaseUrl: "https://SEU-PROJETO.supabase.co",
  supabaseKey: "COLE_AQUI_A_CHAVE_PUBLICA",
  // WhatsApp de suporte com DDI e DDD, só dígitos (ex.: "5527999999999"). Vazio = o botão não aparece.
  whatsapp: "",
  // E-mail de contato mostrado no site.
  email: "contato@speakerconnect.com.br",
  // Mostrados nas páginas (o valor cobrado de verdade é definido no Cloudflare).
  commissionPct: 15,
  verifiedPrice: "R$ 99,90 por ano"
};
