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
  if (/rate limit|security purposes/i.test(m)) return 'Muitas tentativas. Aguarde um minuto e tente de novo.';
  if (/expired|invalid|incorrect/i.test(m) && /token|otp|code|código/i.test(m)) return 'Código inválido ou vencido. Peça um novo código.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Sem conexão. Verifique a internet e tente de novo.';
  return m || 'Algo deu errado. Tente de novo.';
}

/* ---------- login ---------- */
let emailAtual = '';
$('#fEmail').addEventListener('submit', async e => {
  e.preventDefault();
  emailAtual = $('#lEmail').value.trim().toLowerCase();
  const b = $('#lSend'); b.disabled = true; showErr($('#lErr'), '');
  const { error } = await sb.auth.signInWithOtp({ email: emailAtual });
  b.disabled = false;
  if (error) return showErr($('#lErr'), msgErro(error));
  $('#codeMsg').textContent = `Enviamos um código para ${emailAtual}. Confira também a caixa de spam.`;
  $('#fEmail').hidden = true; $('#fCode').hidden = false; $('#lCode').focus();
});
$('#fCode').addEventListener('submit', async e => {
  e.preventDefault();
  const b = $('#lVerify'); b.disabled = true; showErr($('#cErr'), '');
  const { error } = await sb.auth.verifyOtp({ email: emailAtual, token: $('#lCode').value.trim(), type: 'email' });
  b.disabled = false;
  if (error) showErr($('#cErr'), msgErro(error));
});
$('#lBack').addEventListener('click', () => { $('#fCode').hidden = true; $('#fEmail').hidden = false; $('#lCode').value = ''; });
for (const id of ['#logout', '#oLogout']) $(id).addEventListener('click', () => sb.auth.signOut());

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
  await Promise.all([carregarMembros(), carregarListas(), carregarCatalogo()]);
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
  const primeira = versao === null; versao = data;
  if (primeira) return;
  await Promise.all([carregarListas(), carregarCatalogo(), carregarMembros()]);
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
  const v = ['historico', 'familia'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'lista';
  for (const n of ['lista', 'historico', 'familia']) {
    $('#view-' + n).hidden = n !== v;
    const t = $('#tab-' + n); n === v ? t.setAttribute('aria-current', 'page') : t.removeAttribute('aria-current');
  }
  $('#addForm').hidden = v !== 'lista'; $('#bar').hidden = v !== 'lista';
  if (v === 'historico') renderHist();
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
function renderAll() { renderStatus(); renderChips(); renderList(); if (!$('#view-historico').hidden) renderHist(); renderFamilia(); }

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
