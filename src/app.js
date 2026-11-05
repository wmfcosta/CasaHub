import { createClient } from '@neon/neon-js/supabase';
import { SECOES, COMUNS } from './catalogo.js';
import './styles.css';

// Endereço do banco no Neon (sem usuário/senha). O login e o acesso aos dados
// são controlados pelo Neon Auth e pelas regras de linha (RLS) do banco.
const NEON_URL = import.meta.env.VITE_NEON_URL;
// O login passa pelo próprio endereço do app (/api/auth, repassado pela Vercel ao Neon).
// Assim o cookie de sessão é "do próprio site" e o Safari/iPhone não o bloqueia.
// Em localhost (desenvolvimento) o app fala direto com o Neon.
const local = ['localhost', '127.0.0.1'].includes(location.hostname);
const sb = NEON_URL ? createClient(NEON_URL, local ? {} : { auth: { url: location.origin + '/api/auth' } }) : null;
const POLL_MS = 4000;

const DIAS_HIST = 35, DIA = 864e5;
const SECMAP = Object.fromEntries(SECOES.map(s => [s.id, s]));
const $ = s => document.querySelector(s);
const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ts = v => v ? new Date(v).getTime() : 0;
const fmtD = t => new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
const fmtDW = t => new Date(t).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
const secOf = s => SECMAP[s] ? s : 'outros';

let session = null, me = null, fam = null, membros = [];
let listas = [], itens = [], catalogo = [], curId = null;
let passeios = [], paradas = [];
let loaded = false, flashId = null, secFilter = 'todos', pollT = null, versao = null;

/* ---------- utilidades ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));

// O banco do Neon desliga quando fica parado. Logo depois que ele acorda, a primeira
// requisição às vezes chega sem a identificação do usuário. Antes de ler ou gravar,
// confirmamos que o banco já reconhece quem está usando.
let acordado = null, ultimoOk = 0;
function acordar() {
  if (Date.now() - ultimoOk < 60000) return Promise.resolve(true);
  if (!acordado) acordado = (async () => {
    for (let i = 0; i < 6; i++) {
      const { data } = await sb.rpc('quem_sou');
      if (data) { ultimoOk = Date.now(); return true; }
      await sleep(300 * (i + 1));
    }
    return false;
  })().finally(() => { acordado = null; });
  return acordado;
}
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2800); }
function showErr(el, msg) { el.textContent = msg; el.hidden = !msg; }
function screen(id) { for (const s of ['login', 'onboard', 'app']) $('#scr-' + s).hidden = s !== id; }
const nomeDe = id => !id ? 'alguém' : id === me ? 'você' : (membros.find(m => m.user_id === id)?.nome || 'alguém');
function msgErro(e) {
  const m = (e && (e.message || e.error_description)) || '';
  const c = (e && e.code) || '';
  if (/rate limit|security purposes|too many/i.test(m + c)) return 'Muitas tentativas. Aguarde um minuto e tente de novo.';
  if (/INVALID_EMAIL_OR_PASSWORD|invalid email or password|invalid_credentials|invalid login/i.test(m + ' ' + c)) return 'E-mail ou senha incorretos. Se você entrava com código, use "Criar senha".';
  if (/already exists|already registered|user_already_exists/i.test(m + ' ' + c)) return 'Este e-mail já tem conta. Toque em "Já tenho conta" ou, se ainda não tem senha, em "Criar senha".';
  if (/PASSWORD_TOO_SHORT|password.*short|weak_password/i.test(m + ' ' + c)) return 'A senha precisa ter pelo menos 8 caracteres.';
  if (/PASSWORD_TOO_LONG|password.*long/i.test(m + ' ' + c)) return 'Senha muito longa. Use até 128 caracteres.';
  if (/retrieve session|session not found/i.test(m)) return 'O navegador não guardou o login. Atualize a página e tente de novo.';
  if (/expired|invalid|incorrect|TOO_MANY_ATTEMPTS/i.test(m + ' ' + c) && /token|otp|code|código/i.test(m + ' ' + c)) return 'Código inválido ou vencido. Peça um novo código.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Sem conexão. Verifique a internet e tente de novo.';
  return m || 'Algo deu errado. Tente de novo.';
}

/* ---------- login com e-mail e senha ---------- */
const AUTH = local ? null : location.origin + '/api/auth';
// chamadas do login que o kit do Neon não expõe (criar senha por código enviado ao e-mail)
async function authPost(caminho, corpo) {
  try {
    const r = await fetch(`${AUTH}/${caminho}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { data: j, error: null } : { data: null, error: { message: j.message || `Erro ${r.status}`, code: j.code } };
  } catch (err) { return { data: null, error: err }; }
}
function pane(nome) {
  for (const f of document.querySelectorAll('#scr-login [data-pane]')) f.hidden = f.dataset.pane !== nome;
  for (const el of document.querySelectorAll('#scr-login .err')) el.hidden = true;
  const em = $('#lEmail').value || $('#cEmail').value || $('#sEmail').value;
  for (const id of ['#lEmail', '#cEmail', '#sEmail']) if (!$(id).value) $(id).value = em;
  const foco = { login: '#lEmail', cadastro: '#cEmail', senha: '#sEmail', nova: '#nCode' }[nome];
  setTimeout(() => { const f = $(foco); if (nome === 'login' && f.value) $('#lPass').focus(); else f.focus(); }, 0);
}
document.querySelectorAll('#scr-login [data-go]').forEach(b => b.addEventListener('click', () => pane(b.dataset.go)));
document.querySelectorAll('#scr-login .eye').forEach(b => b.addEventListener('click', () => {
  const i = b.previousElementSibling, ver = i.type === 'password';
  i.type = ver ? 'text' : 'password'; b.textContent = ver ? 'Ocultar' : 'Ver'; b.setAttribute('aria-label', ver ? 'Ocultar senha' : 'Mostrar senha');
}));
const emailDe = id => $(id).value.trim().toLowerCase();

async function entrarComSenha(email, senha, errEl) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password: senha });
  if (error) { showErr(errEl, msgErro(error)); return false; }
  session = data?.session || (await sb.auth.getSession()).data?.session;
  if (!session) { showErr(errEl, msgErro({ message: 'session not found' })); return false; }
  for (const id of ['#lPass', '#cPass', '#nPass', '#nCode']) $(id).value = '';
  pane('login');
  await iniciar();
  return true;
}
$('#fLogin').addEventListener('submit', async e => {
  e.preventDefault();
  const b = $('#lBtn'); b.disabled = true; showErr($('#lErr'), '');
  try { await entrarComSenha(emailDe('#lEmail'), $('#lPass').value, $('#lErr')); } finally { b.disabled = false; }
});
$('#fCadastro').addEventListener('submit', async e => {
  e.preventDefault();
  const email = emailDe('#cEmail'), senha = $('#cPass').value;
  if (senha.length < 8) return showErr($('#cadErr'), 'A senha precisa ter pelo menos 8 caracteres.');
  const b = $('#cBtn'); b.disabled = true; showErr($('#cadErr'), '');
  try {
    const { error } = await sb.auth.signUp({ email, password: senha, options: { data: { displayName: email.split('@')[0] } } });
    if (error) return showErr($('#cadErr'), msgErro(error));
    await entrarComSenha(email, senha, $('#cadErr'));
  } finally { b.disabled = false; }
});
let emailSenha = '';
$('#fSenha').addEventListener('submit', async e => {
  e.preventDefault();
  emailSenha = emailDe('#sEmail');
  const b = $('#sSend'); b.disabled = true; showErr($('#sErr'), '');
  const { error } = await authPost('email-otp/send-verification-otp', { email: emailSenha, type: 'forget-password' });
  b.disabled = false;
  if (error) return showErr($('#sErr'), msgErro(error));
  $('#nMsg').textContent = `Se ${emailSenha} tiver conta no CasaHub, o código chega em instantes. Confira também a caixa de spam.`;
  $('#nUser').value = emailSenha;
  pane('nova');
});
$('#fNova').addEventListener('submit', async e => {
  e.preventDefault();
  const senha = $('#nPass').value;
  if (senha.length < 8) return showErr($('#nErr'), 'A senha precisa ter pelo menos 8 caracteres.');
  const b = $('#nBtn'); b.disabled = true; showErr($('#nErr'), '');
  try {
    const { error } = await authPost('email-otp/reset-password', { email: emailSenha, otp: $('#nCode').value.trim(), password: senha });
    if (error) return showErr($('#nErr'), msgErro(error));
    $('#lEmail').value = emailSenha;
    if (await entrarComSenha(emailSenha, senha, $('#nErr'))) toast('Senha criada. Nas próximas vezes, entre com e-mail e senha.');
  } finally { b.disabled = false; }
});
for (const id of ['#logout', '#oLogout']) $(id).addEventListener('click', async () => {
  await sb.auth.signOut();
  session = null; me = null; fam = null; loaded = false; clearInterval(pollT); ultimoOk = 0;
  curId = null; itens = []; listas = []; membros = []; catalogo = []; passeios = []; paradas = []; versao = null;
  location.hash = ''; screen('login'); pane('login');
});

/* ---------- família ---------- */
$('#fJoin').addEventListener('submit', async e => {
  e.preventDefault(); showErr($('#jErr'), '');
  await acordar();
  const { data, error } = await sb.rpc('entrar_familia', { p_codigo: $('#jCode').value, p_meu_nome: $('#jName').value });
  if (error) return showErr($('#jErr'), msgErro(error));
  await abrirFamilia(data);
});
$('#fCreate').addEventListener('submit', async e => {
  e.preventDefault(); showErr($('#crErr'), '');
  await acordar();
  const { data, error } = await sb.rpc('criar_familia', { p_nome_familia: $('#cFam').value, p_meu_nome: $('#cName').value });
  if (error) return showErr($('#crErr'), msgErro(error));
  await abrirFamilia(data);
  location.hash = '#familia';
  toast('Família criada. Compartilhe o código de convite.');
});
$('#fMyName').addEventListener('submit', async e => {
  e.preventDefault();
  const nome = $('#myName').value.trim(); if (!nome) return;
  await acordar();
  const { error } = await sb.from('membros').update({ nome }).eq('familia_id', fam.id).eq('user_id', me);
  if (error) return toast(msgErro(error));
  toast('Nome salvo'); await carregarMembros();
});
$('#copyCode').addEventListener('click', async () => {
  const txt = `Entre na lista de compras da ${fam.nome} no CasaHub: ${location.origin}\nCódigo de convite: ${fam.codigo_convite}`;
  try { await navigator.clipboard.writeText(txt); toast('Convite copiado'); }
  catch { getSelection().selectAllChildren($('#invCode')); toast('Copie o código selecionado'); }
});

async function iniciar() {
  if (!session) { screen('login'); return; }
  me = session.user.id;
  await acordar();
  const { data, error } = await sb.from('membros').select('familia_id, criado_em').eq('user_id', me).order('criado_em').limit(1);
  if (error) { toast(msgErro(error)); return; }
  if (!data.length) { screen('onboard'); return; }
  await abrirFamilia(data[0].familia_id);
}

async function abrirFamilia(id) {
  const { data, error } = await sb.from('familias').select('*').eq('id', id).single();
  if (error) { toast(msgErro(error)); return; }
  fam = data;
  $('#famName').textContent = fam.nome;
  $('#invCode').textContent = fam.codigo_convite;
  screen('app'); route();
  await Promise.all([carregarMembros(), carregarListas(), carregarCatalogo(), carregarPasseios()]);
  loaded = true; renderAll();
  versao = null; acompanhar();
}

/* ---------- dados ---------- */
async function carregarMembros() {
  const { data } = await sb.from('membros').select('user_id,nome,papel,criado_em').eq('familia_id', fam.id).order('criado_em');
  membros = data || []; renderFamilia(); renderList();
}
async function carregarListas() {
  const { data, error } = await sb.from('listas').select('*').eq('familia_id', fam.id).order('criado_em', { ascending: false });
  if (error) return toast(msgErro(error));
  listas = data;
  const aberta = listas.find(l => l.status === 'aberta');
  const novo = aberta?.id || null;
  if (novo !== curId) { curId = novo; await carregarItens(); }
}
async function carregarItens() {
  if (!curId) { itens = []; return; }
  const { data, error } = await sb.from('itens').select('*').eq('lista_id', curId);
  if (error) return toast(msgErro(error));
  itens = data;
}
async function carregarCatalogo() {
  const { data } = await sb.from('catalogo').select('nome,secao').eq('familia_id', fam.id);
  catalogo = data || [];
}

// Atualização "ao vivo": a cada poucos segundos, com o app aberto, pergunta ao banco
// se algo mudou na família (consulta leve) e só então recarrega os dados.
let ocupado = 0;
async function verificar() {
  if (!fam || ocupado || document.visibilityState !== 'visible') return;
  const { data, error } = await sb.rpc('versao_familia', { p_familia: fam.id });
  if (error || data == null) { ultimoOk = 0; return; }
  ultimoOk = Date.now();
  if (data === versao) return;
  versao = data;
  // também na primeira checagem: se a carga inicial veio vazia porque o banco
  // tinha acabado de acordar, ela se corrige aqui
  await Promise.all([carregarListas(), carregarCatalogo(), carregarMembros(), carregarPasseios()]);
  await carregarItens(); renderAll();
}
function acompanhar() {
  clearInterval(pollT);
  if (!fam) return;
  verificar();
  pollT = setInterval(verificar, POLL_MS);
}
// ao voltar para o app, verifica na hora
document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible' && fam) { await acordar(); verificar(); } });
// depois de uma ação própria, considera a versão atual para não recarregar à toa
async function sincronizar() { const { data } = await sb.rpc('versao_familia', { p_familia: fam.id }); if (data != null) versao = data; }

/* ---------- catálogo ---------- */
function fullCatalog() {
  const m = new Map();
  for (const [sec, arr] of Object.entries(COMUNS)) for (const n of arr) m.set(norm(n), { name: n, section: sec });
  for (const c of catalogo) m.set(norm(c.nome), { name: c.nome, section: secOf(c.secao), custom: true });
  return [...m.values()];
}
const findCat = name => { const k = norm(name); return fullCatalog().find(c => norm(c.name) === k); };

/* ---------- ações ---------- */
async function addItem(...a) { ocupado++; try { await acordar(); return await _addItem(...a); } finally { ocupado--; sincronizar(); } }
async function _addItem(name, section, qty, silent) {
  const k = norm(name);
  const dup = itens.find(i => norm(i.nome) === k && !i.comprado);
  if (dup) { flashId = dup.id; renderList(); if (!silent) toast(`${dup.nome} já está na lista`); return true; }
  let lid = curId;
  if (!lid) {
    const { data, error } = await sb.rpc('lista_aberta', { p_familia: fam.id });
    if (error) { toast(msgErro(error)); return false; }
    lid = curId = data;
  }
  const novo = { id: crypto.randomUUID(), lista_id: lid, familia_id: fam.id, nome: name, secao: section, qtd: qty || '', adicionado_por: me };
  itens.push({ ...novo, comprado: false, adicionado_em: new Date().toISOString() });
  flashId = novo.id; renderAll();
  const { error } = await sb.from('itens').insert(novo);
  if (error) {
    itens = itens.filter(i => i.id !== novo.id); renderAll();
    toast(msgErro(error)); await carregarListas(); return false;
  }
  if (!findCat(name)) await sb.from('catalogo').insert({ familia_id: fam.id, nome: name, secao: section, criado_por: me });
  if (!silent) toast(`${name} adicionado`);
  return true;
}
async function toggleItem(it) { ocupado++; try { await acordar(); await _toggleItem(it); } finally { ocupado--; sincronizar(); } }
async function _toggleItem(it) {
  const patch = it.comprado ? { comprado: false, comprado_por: null, comprado_em: null } : { comprado: true, comprado_por: me, comprado_em: new Date().toISOString() };
  Object.assign(it, patch); renderAll();
  const { error } = await sb.from('itens').update(patch).eq('id', it.id);
  if (error) { toast(msgErro(error)); await carregarItens(); renderAll(); }
}
async function removeItem(it) { ocupado++; try { await acordar(); await _removeItem(it); } finally { ocupado--; sincronizar(); } }
async function _removeItem(it) {
  itens = itens.filter(i => i.id !== it.id); renderAll();
  const { error } = await sb.from('itens').delete().eq('id', it.id);
  if (error) { toast(msgErro(error)); await carregarItens(); renderAll(); }
  else toast(`${it.nome} removido`);
}
async function finalizar(levar) { ocupado++; try { await acordar(); await _finalizar(levar); } finally { ocupado--; sincronizar(); } }
async function _finalizar(levar) {
  closeSheet();
  if (!curId) return;
  const pend = itens.filter(i => !i.comprado).length;
  const { error } = await sb.rpc('finalizar_lista', { p_lista: curId, p_levar: levar });
  if (error) return toast(msgErro(error));
  curId = null; itens = [];
  await carregarListas(); renderAll();
  toast(levar && pend ? `Lista finalizada. ${pend} ${pend === 1 ? 'item foi' : 'itens foram'} para a nova lista.` : 'Lista finalizada e guardada no histórico');
}

/* ---------- navegação ---------- */
function route() {
  const v = ['historico', 'passeios', 'familia'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'lista';
  for (const n of ['lista', 'historico', 'passeios', 'familia']) {
    $('#view-' + n).hidden = n !== v;
    const t = $('#tab-' + n); n === v ? t.setAttribute('aria-current', 'page') : t.removeAttribute('aria-current');
  }
  $('#addForm').hidden = v !== 'lista'; $('#bar').hidden = v !== 'lista';
  if (v === 'historico') renderHist();
  if (v === 'passeios') renderPasseios();
}
addEventListener('hashchange', route);

/* ---------- formulário e sugestões ---------- */
const secSel = $('#iSec'), nameI = $('#iName'), sugs = $('#sugs'), hint = $('#hint');
secSel.innerHTML = SECOES.map(s => `<option value="${s.id}">${s.nome}</option>`).join('');
secSel.value = 'mercearia';
let sugIdx = -1, sugList = [];
function updateSugs() {
  const v = nameI.value.trim();
  if (!v) { sugs.hidden = true; hint.hidden = true; return; }
  const k = norm(v), all = fullCatalog();
  sugList = [...all.filter(c => norm(c.name).startsWith(k)), ...all.filter(c => !norm(c.name).startsWith(k) && norm(c.name).includes(k))].slice(0, 6);
  const exact = all.find(c => norm(c.name) === k);
  sugIdx = -1;
  sugs.innerHTML = sugList.map((c, i) => `<li><button type="button" data-i="${i}"><span class="dot" style="--c:var(--s-${c.section})"></span>${esc(c.name)}<span class="sec">${SECMAP[c.section].nome}</span></button></li>`).join('')
    + (exact ? '' : `<li><button type="button" data-new="1" class="new">+ Adicionar “${esc(v)}” como item novo</button></li>`);
  sugs.hidden = false;
  if (exact) { secSel.value = exact.section; hint.hidden = true; }
  else { hint.innerHTML = '<b>Item novo.</b> Escolha a seção; ele passa a aparecer nos itens comuns para toda a família.'; hint.hidden = false; }
}
nameI.addEventListener('input', updateSugs);
nameI.addEventListener('focus', () => { if (nameI.value.trim()) updateSugs(); });
nameI.addEventListener('keydown', e => {
  const btns = [...sugs.querySelectorAll('button[data-i]')];
  if (sugs.hidden || !btns.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sugIdx = (sugIdx + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length; btns.forEach((b, i) => b.classList.toggle('on', i === sugIdx)); }
  else if (e.key === 'Enter' && sugIdx >= 0) { e.preventDefault(); pickSug(sugList[sugIdx]); }
  else if (e.key === 'Escape') sugs.hidden = true;
});
sugs.addEventListener('mousedown', e => e.preventDefault());
sugs.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.new) { sugs.hidden = true; secSel.focus(); return; }
  pickSug(sugList[+b.dataset.i]);
});
function pickSug(c) { nameI.value = c.name; secSel.value = c.section; sugs.hidden = true; hint.hidden = true; $('#iQty').focus(); }
document.addEventListener('click', e => { if (!e.target.closest('#addForm')) sugs.hidden = true; });
$('#addForm').addEventListener('submit', async e => {
  e.preventDefault();
  const name = nameI.value.trim(); if (!name) return nameI.focus();
  const cat = findCat(name);
  const nome = cat ? cat.name : name.charAt(0).toUpperCase() + name.slice(1);
  const qty = $('#iQty').value.trim();
  nameI.value = ''; $('#iQty').value = ''; sugs.hidden = true; hint.hidden = true; nameI.focus();
  await addItem(nome, secSel.value, qty);
});

/* ---------- render ---------- */
function renderAll() { renderStatus(); renderChips(); renderList(); if (!$('#view-historico').hidden) renderHist(); renderPasseios(); renderFamilia(); }

function renderStatus() {
  const cur = listas.find(l => l.id === curId);
  $('#status').textContent = !loaded ? 'Carregando…' : cur ? `Aberta desde ${fmtDW(ts(cur.criado_em))}` : 'Nenhuma lista aberta';
  const n = itens.length, d = itens.filter(i => i.comprado).length;
  $('#pfill').style.width = n ? (d / n * 100) + '%' : '0';
  $('#plbl').textContent = n ? `${d} de ${n} comprados` : 'Nenhum item ainda';
  $('#finBtn').disabled = !curId;
}

function renderChips() {
  const inList = new Set(itens.filter(i => !i.comprado).map(i => norm(i.nome)));
  const all = fullCatalog();
  const secs = SECOES.filter(s => all.some(c => c.section === s.id));
  $('#secfilter').innerHTML = [`<button type="button" data-s="todos" aria-pressed="${secFilter === 'todos'}">Todos</button>`,
    ...secs.map(s => `<button type="button" data-s="${s.id}" aria-pressed="${secFilter === s.id}">${s.nome}</button>`)].join('');
  const order = id => SECOES.findIndex(s => s.id === id);
  const shown = all.filter(c => secFilter === 'todos' || c.section === secFilter)
    .sort((a, b) => order(a.section) - order(b.section) || a.name.localeCompare(b.name, 'pt-BR'));
  $('#chips').innerHTML = shown.map(c => `<button type="button" class="chip${inList.has(norm(c.name)) ? ' in' : ''}" style="--c:var(--s-${c.section})" data-n="${esc(c.name)}" data-s="${c.section}"><span class="dot"></span>${esc(c.name)}</button>`).join('');
  $('#commonCount').textContent = `· ${all.length}`;
}
$('#secfilter').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; secFilter = b.dataset.s; renderChips(); });
$('#chips').addEventListener('click', e => { const b = e.target.closest('.chip'); if (b) addItem(b.dataset.n, b.dataset.s, ''); });

const CHECK = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="var(--accent-ink)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function renderList() {
  const el = $('#list');
  if (!loaded) { el.innerHTML = '<div class="empty"><strong>Abrindo a lista…</strong>Buscando o que a família já anotou.</div>'; return; }
  if (!itens.length) { el.innerHTML = '<div class="empty"><strong>A lista está vazia</strong>Digite um item no campo acima ou toque em <b>Itens comuns</b> para escolher rápido. Tudo que você adicionar aparece na hora para toda a família.</div>'; return; }
  const pend = itens.filter(i => !i.comprado), done = itens.filter(i => i.comprado);
  const row = it => `<li class="item${it.comprado ? ' is-done' : ''}${it.id === flashId ? ' flash' : ''}" style="--c:var(--s-${secOf(it.secao)})">
    <button class="check" type="button" aria-pressed="${!!it.comprado}" aria-label="${it.comprado ? 'Desmarcar' : 'Marcar como comprado'}: ${esc(it.nome)}" data-a="t" data-id="${it.id}">${CHECK}</button>
    <div class="body"><div class="name">${esc(it.nome)}${it.qtd ? `<span class="qty">${esc(it.qtd)}</span>` : ''}</div>
    <div class="meta">${it.comprado ? `comprado por ${esc(nomeDe(it.comprado_por))}` : `por ${esc(nomeDe(it.adicionado_por))}`}</div></div>
    <button class="del" type="button" aria-label="Remover ${esc(it.nome)}" data-a="d" data-id="${it.id}">×</button></li>`;
  let html = '';
  for (const s of SECOES) {
    const g = pend.filter(i => secOf(i.secao) === s.id).sort((a, b) => ts(a.adicionado_em) - ts(b.adicionado_em));
    if (g.length) html += `<section class="group"><h2><span class="dot" style="--c:var(--s-${s.id})"></span>${s.nome}<span class="n">${g.length}</span></h2><ul class="items">${g.map(row).join('')}</ul></section>`;
  }
  if (!pend.length) html += '<div class="empty"><strong>Tudo comprado!</strong>Finalize a lista para guardá-la no histórico e começar uma nova.</div>';
  if (done.length) html += `<section class="group"><h2>Já comprados<span class="n">${done.length}</span></h2><ul class="items">${done.sort((a, b) => ts(b.comprado_em) - ts(a.comprado_em)).map(row).join('')}</ul></section>`;
  el.innerHTML = html;
  flashId = null;
}
$('#list').addEventListener('click', e => {
  const b = e.target.closest('button[data-a]'); if (!b) return;
  const it = itens.find(i => i.id === b.dataset.id); if (!it) return;
  b.dataset.a === 't' ? toggleItem(it) : removeItem(it);
});

const histOpen = new Map();
function renderHist() {
  const el = $('#hist');
  const limite = Date.now() - DIAS_HIST * DIA;
  const fechadas = listas.filter(l => l.status === 'finalizada' && ts(l.finalizada_em) >= limite).sort((a, b) => ts(b.finalizada_em) - ts(a.finalizada_em));
  if (!fechadas.length) { el.innerHTML = '<div class="empty"><strong>Nenhuma lista finalizada ainda</strong>Quando alguém finalizar a lista atual, ela aparece aqui e fica guardada por 5 semanas.</div>'; return; }
  el.innerHTML = fechadas.map(l => {
    const fim = ts(l.finalizada_em);
    const left = Math.max(0, Math.ceil((fim + DIAS_HIST * DIA - Date.now()) / DIA));
    const h = histOpen.get(l.id);
    let body = '';
    if (h === 'loading') body = '<div class="hbody"><p class="status">Carregando itens…</p></div>';
    else if (h) {
      const pend = h.filter(i => !i.comprado);
      body = `<div class="hbody"><ul>${[...h].sort((a, b) => (b.comprado ? 1 : 0) - (a.comprado ? 1 : 0) || a.nome.localeCompare(b.nome, 'pt-BR')).map(i => `<li class="${i.comprado ? 'ok' : 'no'}"><span class="mk">${i.comprado ? '✓' : '✗'}</span><span>${esc(i.nome)}${i.qtd ? ` <span class="qty">${esc(i.qtd)}</span>` : ''}</span></li>`).join('') || '<li>Lista sem itens</li>'}</ul>
        ${pend.length ? `<button class="btn ghost" type="button" data-carry="${l.id}">Adicionar os ${pend.length} não comprados à lista atual</button>` : ''}</div>`;
    }
    return `<article class="hcard"><button type="button" data-h="${l.id}" aria-expanded="${!!h}">
      <span class="t">${fmtD(ts(l.criado_em))} a ${fmtD(fim)}</span>
      <span class="exp">sai em ${left} ${left === 1 ? 'dia' : 'dias'}</span>
      <span class="s">${l.total ?? 0} itens · ${l.comprados ?? 0} comprados · finalizada por ${esc(nomeDe(l.finalizada_por))}</span>
    </button>${body}</article>`;
  }).join('');
}
$('#hist').addEventListener('click', async e => {
  const c = e.target.closest('[data-carry]');
  if (c) {
    const h = histOpen.get(c.dataset.carry); if (!Array.isArray(h)) return;
    const pend = h.filter(i => !i.comprado); c.disabled = true;
    for (const p of pend) await addItem(p.nome, p.secao, p.qtd, true);
    toast(`${pend.length} ${pend.length === 1 ? 'item adicionado' : 'itens adicionados'} à lista atual`); return;
  }
  const b = e.target.closest('[data-h]'); if (!b) return;
  const id = b.dataset.h;
  if (histOpen.has(id)) { histOpen.delete(id); return renderHist(); }
  histOpen.set(id, 'loading'); renderHist();
  await acordar();
  const { data, error } = await sb.from('itens').select('nome,secao,qtd,comprado').eq('lista_id', id);
  if (error) { histOpen.delete(id); toast(msgErro(error)); } else histOpen.set(id, data);
  renderHist();
});

function renderFamilia() {
  if (!fam) return;
  $('#people').innerHTML = membros.map(m => `<li><span class="av">${esc((m.nome || '?').trim().charAt(0).toUpperCase())}</span><span>${esc(m.nome)}${m.user_id === me ? ' (você)' : ''}</span><span class="tag">${m.papel === 'admin' ? 'criou a família' : ''}</span></li>`).join('');
  const meu = membros.find(m => m.user_id === me);
  if (meu && document.activeElement !== $('#myName')) $('#myName').value = meu.nome;
}

/* ---------- passeios ---------- */
// A hora de chegada e de volta é gravada pelo próprio banco (relógio do servidor) no
// momento do toque. O app não envia horário nenhum e ninguém pode editar os registros.
const DIAS_PAS = 30;
const fmtH = t => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const mesmoDia = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
function fmtDur(ms) {
  const m = Math.max(0, Math.round(ms / 6e4));
  if (m < 1) return "menos de 1 min";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h${String(r).padStart(2, '0')}` : `${h}h`;
}
function diaRel(t) {
  const d = new Date(t), hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const d0 = new Date(d); d0.setHours(0, 0, 0, 0);
  const n = Math.round((hoje - d0) / DIA);
  return n === 0 ? 'hoje' : n === 1 ? 'ontem' : fmtDW(t);
}
// "às 14:32" no mesmo dia; "ontem às 22:10" ou "qua., 04/11 às 22:10" em outro dia
const quando = (t, ref = Date.now()) => mesmoDia(t, ref) ? `às ${fmtH(t)}` : `${diaRel(t)} às ${fmtH(t)}`;

async function carregarPasseios() {
  if (!fam) return;
  const desde = new Date(Date.now() - DIAS_PAS * DIA).toISOString();
  const [a, b] = await Promise.all([
    sb.from('passeios').select('id,user_id,iniciado_em,voltou_em').eq('familia_id', fam.id).gte('iniciado_em', desde).order('iniciado_em', { ascending: false }).limit(300),
    sb.from('passeio_paradas').select('passeio_id,local,chegou_em').eq('familia_id', fam.id).gte('chegou_em', desde).order('chegou_em').limit(1000),
  ]);
  if (a.error || b.error) return;
  passeios = a.data; paradas = b.data;
}
const paradasDe = id => paradas.filter(p => p.passeio_id === id);
const meuAberto = () => passeios.find(p => p.user_id === me && !p.voltou_em);

let pBusy = false, locaisHtml = null;
async function chegar(local) {
  if (pBusy) return; pBusy = true; ocupado++;
  const b = $('#pChegarB'); b.disabled = true;
  try {
    await acordar();
    const { data, error } = await sb.rpc('passeio_chegar', { p_familia: fam.id, p_local: local });
    if (error) return toast(msgErro(error));
    $('#pLocal').value = '';
    await carregarPasseios(); renderPasseios();
    toast(`Chegada em ${local} registrada ${quando(data)}`);
  } finally { pBusy = false; ocupado--; b.disabled = false; sincronizar(); }
}
async function voltar() {
  if (pBusy) return; pBusy = true; ocupado++;
  const b = $('#pVoltar'); b.disabled = true;
  try {
    await acordar();
    const { data, error } = await sb.rpc('passeio_voltar', { p_familia: fam.id });
    if (error) { toast(msgErro(error)); await carregarPasseios(); renderPasseios(); return; }
    await carregarPasseios(); renderPasseios();
    toast(`Volta para casa registrada ${quando(data)}`);
  } finally { pBusy = false; ocupado--; b.disabled = false; desarmarVolta(); sincronizar(); }
}

$('#fChegar').addEventListener('submit', e => {
  e.preventDefault();
  const local = $('#pLocal').value.replace(/\s+/g, ' ').trim();
  if (!local) return $('#pLocal').focus();
  chegar(local);
});
// "Voltei para casa" pede um segundo toque, porque o registro não pode ser desfeito
let voltaArm = null;
function desarmarVolta() { clearTimeout(voltaArm); voltaArm = null; const b = $('#pVoltar'); b.classList.remove('confirm'); b.textContent = 'Voltei para casa'; }
$('#pVoltar').addEventListener('click', () => {
  const b = $('#pVoltar');
  if (!voltaArm) { b.classList.add('confirm'); b.textContent = 'Toque de novo para confirmar'; voltaArm = setTimeout(desarmarVolta, 4000); return; }
  clearTimeout(voltaArm); voltar();
});

function renderPasseios() {
  if (!fam || $('#view-passeios').hidden) return;
  const agora = Date.now();
  const aberto = meuAberto();

  // meu estado
  $('#pCasa').hidden = !!aberto; $('#pFora').hidden = !aberto;
  if (aberto) {
    const ps = paradasDe(aberto.id), ult = ps[ps.length - 1];
    $('#pOnde').textContent = ult ? ult.local : 'Fora de casa';
    $('#pDesde').textContent = ult ? `Chegou ${quando(ult.chegou_em)} · há ${fmtDur(agora - ts(ult.chegou_em))}` : '';
    $('#pStops').innerHTML = ps.length > 1 ? ps.slice(0, -1).map(p => `<li><b>${fmtH(p.chegou_em)}</b><span>${esc(p.local)}</span></li>`).join('') : '';
    $('#pChegarT').textContent = 'Mudou de lugar?';
    $('#pChegarB').textContent = 'Registrar chegada no novo lugar';
  } else {
    const ultimo = passeios.find(p => p.user_id === me && p.voltou_em);
    $('#pUltima').textContent = ultimo ? `Última volta registrada ${quando(ultimo.voltou_em)}.` : 'Quando sair, registre aqui cada lugar em que chegar.';
    $('#pChegarT').textContent = 'Chegou em algum lugar?';
    $('#pChegarB').textContent = 'Registrar chegada';
  }

  // sugestões de lugares já usados pela família
  const locais = [...new Map([...paradas].reverse().map(p => [norm(p.local), p.local])).values()].slice(0, 30);
  const opts = locais.map(l => `<option value="${esc(l)}">`).join('');
  if (opts !== locaisHtml) { locaisHtml = opts; $('#pLocais').innerHTML = opts; }

  const linha = (p, live) => {
    const ps = paradasDe(p.id), ult = ps[ps.length - 1];
    const nome = nomeDe(p.user_id);
    const ini = ps[0]?.chegou_em || p.iniciado_em;
    const when = live ? `há ${fmtDur(agora - ts(ult?.chegou_em || ini))}`
      : `${fmtH(ini)} → ${mesmoDia(ini, p.voltou_em) ? fmtH(p.voltou_em) : `${diaRel(p.voltou_em)} ${fmtH(p.voltou_em)}`}`;
    const where = live
      ? `${ult ? `${esc(ult.local)} desde ${fmtH(ult.chegou_em)}` : 'fora de casa'}${ps.length > 1 ? ` · antes: ${ps.slice(0, -1).map(x => `${esc(x.local)} ${fmtH(x.chegou_em)}`).join(', ')}` : ''}`
      : `${ps.map(x => `${esc(x.local)} ${fmtH(x.chegou_em)}`).join(' · ') || 'sem lugar registrado'} · voltou para casa ${fmtH(p.voltou_em)} · ${fmtDur(ts(p.voltou_em) - ts(ini))} fora`;
    return `<div class="prow${live ? ' live' : ''}"><span class="av">${esc((nome || '?').trim().charAt(0).toUpperCase())}</span>
      <span class="who">${esc(nome === 'você' ? 'Você' : nome)}</span><span class="when">${when}</span>
      <span class="where">${where}</span></div>`;
  };

  // quem está fora agora
  const fora = passeios.filter(p => !p.voltou_em).sort((a, b) => ts(a.iniciado_em) - ts(b.iniciado_em));
  $('#pAgora').innerHTML = fora.length ? `<div class="plist">${fora.map(p => linha(p, true)).join('')}</div>`
    : '<p class="pvazio">Ninguém com passeio em andamento.</p>';

  // histórico dos passeios encerrados, por dia
  const fechados = passeios.filter(p => p.voltou_em);
  if (!fechados.length) { $('#pHist').innerHTML = '<p class="pvazio">Nenhum passeio encerrado ainda.</p>'; return; }
  const dias = new Map();
  for (const p of fechados) {
    const k = new Date(p.iniciado_em).toDateString();
    if (!dias.has(k)) dias.set(k, []); dias.get(k).push(p);
  }
  $('#pHist').innerHTML = [...dias.values()].map(g => `<div><h3>${diaRel(g[0].iniciado_em)}</h3><div class="plist">${g.map(p => linha(p, false)).join('')}</div></div>`).join('');
}
// atualiza o "há X min" enquanto a aba está aberta
setInterval(() => { if (document.visibilityState === 'visible') renderPasseios(); }, 30000);

/* ---------- finalizar ---------- */
function closeSheet() { $('#sheet').hidden = true; $('#finBtn').focus(); }
$('#finBtn').addEventListener('click', () => {
  const pend = itens.filter(i => !i.comprado).length;
  $('#shP').textContent = !itens.length ? 'A lista está vazia. Ela será encerrada sem itens.'
    : pend ? `${itens.length - pend} de ${itens.length} itens foram comprados. ${pend} ${pend === 1 ? 'ficou' : 'ficaram'} sem comprar.`
    : `Todos os ${itens.length} itens foram comprados. A lista vai para o histórico por 5 semanas.`;
  const c = $('#shCarry'); c.hidden = !pend; c.textContent = `Finalizar e levar os ${pend} não comprados para a próxima`;
  $('#shClose').className = pend ? 'btn ghost' : 'btn';
  $('#sheet').hidden = false; (pend ? c : $('#shClose')).focus();
});
$('#shCarry').addEventListener('click', () => finalizar(true));
$('#shClose').addEventListener('click', () => finalizar(false));
$('#shCancel').addEventListener('click', closeSheet);
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

/* ---------- início ---------- */
if (!sb) {
  document.body.innerHTML = '<div class="wrap gate"><div class="card"><h2>Configuração pendente</h2><p>Defina a variável VITE_NEON_URL com o endereço do banco no Neon.</p></div></div>';
} else {
  let iniciado = false;
  sb.auth.onAuthStateChange((evt, s) => {
    const mudouUsuario = (s?.user?.id || null) !== (session?.user?.id || null);
    session = s;
    if (!iniciado || mudouUsuario) {
      iniciado = true;
      if (!s) { fam = null; loaded = false; clearInterval(pollT); }
      setTimeout(iniciar, 0);
    }
  });
}
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
