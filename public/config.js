// Configurações públicas do SpeakerConnect (site, app e painel da equipe).
// Só valores que podem ficar visíveis. NUNCA coloque aqui a chave "service_role" nem tokens do Mercado Pago.
window.SC = {
  // Supabase > Project Settings > API: "Project URL" e a chave pública ("publishable" ou "anon").
  supabaseUrl: "https://yzixmufoluzgrlxktwln.supabase.co",
  supabaseKey: "sb_publishable_JIYBF0FFu0JX4I1VRH_BCA_EMIh-r_o",
  // WhatsApp de suporte com DDI e DDD, só dígitos (ex.: "5527999999999"). Vazio = o botão não aparece.
  whatsapp: "5527996133207",
  // E-mail de contato mostrado no site.
  email: "contato@speakerconnect.com.br",
  // Redes sociais mostradas no rodapé (endereço completo). Vazio = o ícone não aparece.
  instagram: "https://www.instagram.com/speakerconnect.com.br/",
  linkedin: "https://www.linkedin.com/company/145289979/",
  // Mostrados nas páginas (o valor cobrado de verdade é definido no Cloudflare).
  // Cloudflare Turnstile (anti-robô) no login, cadastro e "esqueci minha senha". Vazio = desligado.
  // A Secret Key NÃO vai aqui: ela fica no Supabase (Authentication > Attack Protection).
  turnstile: "0x4AAAAAAFtBdB9QtTL-OO2z",
  commissionPct: 20,
  // Sinal e saldo (iguais a DEPOSIT_PCT, BALANCE_DAYS_BEFORE e CANCEL_FEE_PCT no Cloudflare).
  depositPct: 30,
  balanceDays: 7,
  cancelFeePct: 10,
  verifiedPrice: "R$ 199,00 por ano",
  // Cloudflare Web Analytics (visitas do site, sem cookies): o "token" do site em Analytics & Logs > Web Analytics.
  // Vazio = não mede. Se a medição automática do Cloudflare já estiver ligada, deixe vazio para não contar em dobro.
  cfBeacon: "",
  // Tag do Google Ads (conta 579-705-4625). Conta como conversão quem chega em /obrigado. Vazio = desligado.
  googleAds: "AW-18588382651"
};
