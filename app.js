// app.js — Firebase + fotos via Apps Script + filtros/ordenação + máscara chip
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, query, orderBy, limit, getDocs, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ===== CONFIG FIREBASE ===== */
const firebaseConfig = {
  apiKey: "AIzaSyByCs3YBuxUug6XehgQtwfPII-0pIIXl-c",
  authDomain: "cameras-cd27f.firebaseapp.com",
  projectId: "cameras-cd27f",
  storageBucket: "cameras-cd27f.firebasestorage.app",
  messagingSenderId: "555386432094",
  appId: "1:555386432094:web:7e875f76d3af72f7cde2cf",
  measurementId: "G-00JGPVTHF8"
};
/* ================================== */

/* ===== URL do Apps Script (UPLOAD/DELETE) ===== */
const UPLOAD_API_URL = 'https://script.google.com/macros/s/AKfycbyJSWFHxusn4q6kuWc2CFCIzJ2vhE5bXEEwoIQRzykb8CVfiEJ5d7pru7BIMmxrFqy75A/exec';
/* ============================================== */

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

const $ = (s) => document.querySelector(s);
const toast = (t) => { const el = document.querySelector('#msg'); if (el) { el.textContent = t; setTimeout(()=> el.textContent='', 3000); } };

/* ===== Helpers ===== */
function formatTs(ts){
  if (!ts) return 0;
  const d = ts?.toDate ? ts.toDate() : (ts?.seconds ? new Date(ts.seconds*1000) : new Date(ts));
  return d.getTime ? d.getTime() : 0;
}
function ymdToInput(isoOrYmd){
  if(!isoOrYmd) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoOrYmd)) return isoOrYmd;
  const d = new Date(isoOrYmd); if (isNaN(+d)) return '';
  return d.toISOString().slice(0,10);
}

/* ====== Máscara para Número do Chip/ICCID ====== */
function maskNumeroChip(value){
  const digits = String(value||'').replace(/\D/g,'');
  if (digits.startsWith('89') && digits.length >= 15){ // ICCID geralmente 19-22
    return digits.replace(/(\d{4})(?=\d)/g,'$1 ').trim(); // grupos de 4
  }
  if (digits.length >= 11){ // celular BR
    const d = digits.slice(0,11);
    return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7,11)}`;
  }
  if (digits.length >= 10){
    const d = digits.slice(0,10);
    return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6,10)}`;
  }
  // fallback: agrupa de 4
  return digits.replace(/(\d{4})(?=\d)/g,'$1 ').trim();
}

/* ====== Seleção de fotos (cadastro) ====== */
let selectedFiles = []; // Array<File>

function fileToDataUrl(file){
  return new Promise((resolve, reject)=>{
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}
function addToSelection(fileList){
  const novos = Array.from(fileList || []);
  for (const f of novos){
    if (selectedFiles.length >= 5) break;
    const key = f.name+'|'+f.size+'|'+f.lastModified;
    const exists = selectedFiles.some(x => (x.name+'|'+x.size+'|'+x.lastModified)===key);
    if (!exists) selectedFiles.push(f);
  }
  renderPreview();
  const input = $('#fotos'); if (input) input.value = '';
}
function removeFromSelection(idx){
  selectedFiles.splice(idx, 1);
  renderPreview();
}
function renderPreview(){
  const box = $('#preview'); if(!box) return;
  box.innerHTML = '';
  selectedFiles.forEach((f, i)=>{
    const wrap = document.createElement('div');
    wrap.className = 'thumb-wrap';
    const img = document.createElement('img');
    img.src = URL.createObjectURL(f);
    img.onload = () => URL.revokeObjectURL(img.src);
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'remove-thumb'; btn.innerHTML = '×'; btn.title = 'Remover';
    btn.onclick = ()=> removeFromSelection(i);
    wrap.appendChild(img); wrap.appendChild(btn);
    box.appendChild(wrap);
  });
}

/* ===== Upload / Delete no Apps Script ===== */
async function enviarFotosDrive(files){
  const arr = Array.from(files || []);
  if(!arr.length) return [];
  const payload = { action: 'upload', files: [] };
  for(let i=0;i<arr.length;i++){
    const f = arr[i];
    const dataUrl = await fileToDataUrl(f);
    payload.files.push({ name: f.name, dataUrl });
  }
  const r = await fetch(UPLOAD_API_URL, {
    method: 'POST',
    headers: { 'Content-Type':'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
  });
  const j = await r.json();
  if(!j.ok) throw new Error(j.error || 'Falha ao enviar fotos');
  return Array.isArray(j.urls) ? j.urls : []; // [{id,url}]
}
async function deletarFotoDrive(fileId){
  if(!fileId) return {ok:true};
  const r = await fetch(UPLOAD_API_URL, {
    method: 'POST',
    headers: { 'Content-Type':'text/plain;charset=utf-8' },
    body: JSON.stringify({ action:'delete', fileId })
  });
  try { return await r.json(); } catch { return {ok:false}; }
}

/* ===== Normalização de fotos ===== */
function normalizeFotos(fotos){
  if(!Array.isArray(fotos)) return [];
  return fotos.map(x=>{
    if (typeof x === 'string') return { id:'', url:x };
    if (x && typeof x === 'object') return { id:(x.id||''), url:(x.url||'') };
    return { id:'', url:'' };
  }).filter(x=>x.url);
}

/* ===== Firestore ===== */
async function buscarPorCPM(cpm){
  if(!cpm) return null;
  const snap = await getDoc(doc(db, 'registros', cpm.trim()));
  return snap.exists() ? snap.data() : null;
}
async function cpmExiste(cpm){
  const snap = await getDoc(doc(db, 'registros', cpm));
  return snap.exists();
}
async function criarRegistro({
  cpm, status, observacoes, dataFabricacao, senhaCadeado,
  modemLogin, modemSenha, numeroChip, uid, email
}){
  if(!cpm) throw new Error('Informe o CPM.');
  if(await cpmExiste(cpm)) throw new Error('Este CPM já existe.');

  const fotos = await enviarFotosDrive(selectedFiles); // [{id,url}]

  const refDoc = doc(db, 'registros', cpm);
  const data = {
    cpm,
    status: status || 'ONLINE',
    observacoes: observacoes || '',
    dataFabricacao: dataFabricacao || '',
    senhaCadeado: senhaCadeado || '',
    modemLogin: modemLogin || '',
    modemSenha: modemSenha || '',
    numeroChip: numeroChip || '',
    fotos,
    criadoEm: serverTimestamp(),
    criadoPor: { uid, email }
  };
  await setDoc(refDoc, data, { merge:true });
  return cpm;
}
async function listarUltimos(n=200){
  const q = query(collection(db, 'registros'), orderBy('criadoEm','desc'), limit(n));
  const snaps = await getDocs(q);
  return snaps.docs.map(d => d.data());
}
async function atualizarRegistro(cpm, fields){
  await updateDoc(doc(db, 'registros', cpm), fields);
}
async function excluirRegistro(cpm){
  await deleteDoc(doc(db, 'registros', cpm));
}

/* ===== CSV ===== */
function baixarCSVSelecionavel(dados, campos){
  const map = {
    cpm:            r => r.cpm || '',
    status:         r => r.status || '',
    dataFabricacao: r => r.dataFabricacao || '',
    senhaCadeado:   r => r.senhaCadeado || '',
    modemLogin:     r => r.modemLogin || '',
    modemSenha:     r => r.modemSenha || '',
    numeroChip:     r => r.numeroChip || '',
    observacoes:    r => r.observacoes || '',
    email:          r => r.criadoPor?.email || '',
    criadoEm:       r => (new Date(formatTs(r.criadoEm))).toISOString(),
    fotos:          r => normalizeFotos(r.fotos||[]).map(f=>f.url).join(' | ')
  };
  const header = campos;
  const linhas = [header.join(',')];
  dados.forEach(r=>{
    const row = campos.map(k=>{
      const v = (map[k] ? map[k](r) : (r[k] ?? ''));
      return `"${String(v).replaceAll('"','""')}"`;
    });
    linhas.push(row.join(','));
  });
  const blob = new Blob([linhas.join('\r\n')], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `registros_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
}
async function obterDadosParaExportar({cpms, status, qtd}){
  if (Array.isArray(cpms) && cpms.length){
    const out = [];
    for (const id of cpms){
      const docu = await buscarPorCPM(id);
      if (docu && (status==='Todos' || docu.status===status)) out.push(docu);
    }
    return out;
  }
  const n = Math.max(1, Math.min(Number(qtd||500), 5000));
  let arr = await listarUltimos(n);
  if (status && status !== 'Todos') arr = arr.filter(r=> r.status === status);
  return arr;
}

/* ===== LOGIN PAGE ===== */
function initAuth(){
  $('#tabLogin')?.addEventListener('click', ()=>{
    $('#tabLogin').classList.add('active');
    $('#tabRegister').classList.remove('active');
    $('#paneLogin').hidden=false; $('#paneRegister').hidden=true;
  });
  $('#tabRegister')?.addEventListener('click', ()=>{
    $('#tabRegister').classList.add('active');
    $('#tabLogin').classList.remove('active');
    $('#paneRegister').hidden=false; $('#paneLogin').hidden=true;
  });

  $('#btnLogin')?.addEventListener('click', async ()=>{
    try{ await signInWithEmailAndPassword(auth, $('#loginEmail').value, $('#loginPass').value); }
    catch(e){ toast('Falha ao entrar: '+e.message); }
  });
  $('#btnReset')?.addEventListener('click', async ()=>{
    try{ await sendPasswordResetEmail(auth, $('#loginEmail').value); toast('Link enviado.'); }
    catch(e){ toast('Erro: '+e.message); }
  });
  $('#btnRegister')?.addEventListener('click', async ()=>{
    try{ await createUserWithEmailAndPassword(auth, $('#regEmail').value, $('#regPass').value); }
    catch(e){ toast('Erro ao registrar: '+e.message); }
  });

  onAuthStateChanged(auth, (user)=>{ if (user) location.href='dashboard.html'; });
}

/* ===== Edição (modal) ===== */
let editing = null;
let editFotos = [];      // [{id,url}]
let editNovasFiles = []; // File[]
function renderEditFotosExistentes(){
  const box = $('#editFotosExistentes'); if(!box) return;
  box.innerHTML = '';
  editFotos.forEach((f, i)=>{
    const wrap = document.createElement('div');
    wrap.className = 'thumb-wrap';
    const img = document.createElement('img'); img.src = f.url;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'remove-thumb'; btn.title = 'Remover (do registro)';
    btn.textContent = '🗑️';
    btn.onclick = async ()=>{
      if (confirm('Remover esta foto do registro?')){
        const removed = editFotos.splice(i,1)[0];
        renderEditFotosExistentes();
        if (removed?.id){ await deletarFotoDrive(removed.id); } // opcional
      }
    };
    wrap.appendChild(img); wrap.appendChild(btn);
    box.appendChild(wrap);
  });
}
function renderEditPreviewNovas(){
  const box = $('#editPreviewNovas'); if(!box) return;
  box.innerHTML = '';
  editNovasFiles.forEach((f, i)=>{
    const wrap = document.createElement('div');
    wrap.className = 'thumb-wrap';
    const img = document.createElement('img');
    img.src = URL.createObjectURL(f);
    img.onload = ()=> URL.revokeObjectURL(img.src);
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'remove-thumb'; btn.textContent = '×'; btn.title = 'Remover nova foto';
    btn.onclick = ()=>{ editNovasFiles.splice(i,1); renderEditPreviewNovas(); };
    wrap.appendChild(img); wrap.appendChild(btn);
    box.appendChild(wrap);
  });
}

/* ===== Lista com filtros/ordenação ===== */
let cacheDados = []; // armazena últimos carregados

function aplicarFiltrosOrdenacao(arr){
  const termo = ($('#buscaLista')?.value || '').trim().toLowerCase();
  const st = $('#filtroStatusLista')?.value || 'Todos';
  const ord = $('#ordenarPor')?.value || 'data_desc';

  let out = [...arr];

  if (st !== 'Todos') out = out.filter(r => (r.status === st));
  if (termo){
    out = out.filter(r =>
      (r.cpm||'').toLowerCase().includes(termo) ||
      (r.observacoes||'').toLowerCase().includes(termo)
    );
  }

  out.sort((a,b)=>{
    if (ord === 'data_desc') return formatTs(b.criadoEm) - formatTs(a.criadoEm);
    if (ord === 'data_asc')  return formatTs(a.criadoEm) - formatTs(b.criadoEm);
    if (ord === 'cpm_asc')   return String(a.cpm||'').localeCompare(String(b.cpm||''), 'pt-BR', {numeric:true});
    if (ord === 'cpm_desc')  return String(b.cpm||'').localeCompare(String(a.cpm||''), 'pt-BR', {numeric:true});
    return 0;
  });

  return out;
}

/* ===== DASHBOARD ===== */
function initApp(){
  // seleção no cadastro
  $('#fotos')?.addEventListener('change', ()=> addToSelection($('#fotos').files));

  // máscara número do chip/ICCID
  const maskOn = (el)=> el && el.addEventListener('input', e => e.target.value = maskNumeroChip(e.target.value));
  maskOn($('#novoNumeroChip'));
  maskOn($('#editNumeroChip'));

  // modal export
  $('#exportCsv')?.addEventListener('click', ()=> $('#exportModal')?.showModal());
  $('#expCancel')?.addEventListener('click', (e)=>{ e.preventDefault(); $('#exportModal')?.close(); });
  $('#expToggle')?.addEventListener('click', ()=>{
    const boxes = [...document.querySelectorAll('.exp-col')];
    const allChecked = boxes.every(b=>b.checked);
    boxes.forEach(b=> b.checked = !allChecked);
  });
  $('#expConfirm')?.addEventListener('click', async ()=>{
    const campos = [...document.querySelectorAll('.exp-col:checked')].map(i=> i.value);
    if (!campos.length){ alert('Selecione pelo menos 1 coluna.'); return; }
    const qtd = parseInt($('#expQtd')?.value || '500', 10);
    const status = $('#expStatus')?.value || 'Todos';
    const cpmsText = ($('#expCpms')?.value || '').trim();
    const cpms = cpmsText ? cpmsText.split(/\r?\n/).map(s=>s.trim()).filter(Boolean) : [];
    try{
      const dados = await obterDadosParaExportar({cpms, status, qtd});
      baixarCSVSelecionavel(dados, campos);
      $('#exportModal')?.close();
    }catch(e){ alert('Erro ao gerar CSV: ' + e.message); }
  });

  // modal editar: novas fotos
  $('#editNovasFotos')?.addEventListener('change', ()=>{
    const files = Array.from($('#editNovasFotos').files||[]);
    for(const f of files){
      if (editNovasFiles.length + editFotos.length >= 5) break;
      editNovasFiles.push(f);
    }
    $('#editNovasFotos').value = '';
    renderEditPreviewNovas();
  });

  // salvar edição
  $('#salvarEdicao')?.addEventListener('click', async ()=>{
    const cpm = $('#editCPM').value;
    const fields = {
      status: $('#editStatus').value,
      dataFabricacao: $('#editDataFab').value,
      senhaCadeado: $('#editSenhaCadeado').value.trim(),
      modemLogin: $('#editModemLogin').value.trim(),
      modemSenha: $('#editModemSenha').value.trim(),
      numeroChip: $('#editNumeroChip').value.trim(),
      observacoes: $('#editObservacoes').value.trim()
    };
    try{
      let novas = [];
      if (editNovasFiles.length){
        novas = await enviarFotosDrive(editNovasFiles); // [{id,url}]
      }
      const fotosFinal = [...editFotos, ...novas].slice(0,5);
      await atualizarRegistro(cpm, { ...fields, fotos: fotosFinal });
      $('#editModal').close();
      cacheDados = await listarUltimos(200);
      renderLista(aplicarFiltrosOrdenacao(cacheDados));
    }catch(e){ alert('Erro ao salvar edição: '+e.message); }
  });

  // filtros e ordenação
  $('#buscaLista')?.addEventListener('input', ()=> renderLista(aplicarFiltrosOrdenacao(cacheDados)));
  $('#filtroStatusLista')?.addEventListener('change', ()=> renderLista(aplicarFiltrosOrdenacao(cacheDados)));
  $('#ordenarPor')?.addEventListener('change', ()=> renderLista(aplicarFiltrosOrdenacao(cacheDados)));
  $('#btnAtualizar')?.addEventListener('click', async ()=>{
    cacheDados = await listarUltimos(200);
    renderLista(aplicarFiltrosOrdenacao(cacheDados));
  });

  // auth
  onAuthStateChanged(auth, async (user)=>{
    if(!user){ location.href='index.html'; return; }
    const who = $('#who'); if (who) who.textContent = user.email||'';
    cacheDados = await listarUltimos(200);
    renderLista(aplicarFiltrosOrdenacao(cacheDados));
  });

  $('#btnLogout')?.addEventListener('click', ()=> signOut(auth));

  // CRIAR (cadastro)
  $('#btnCriar')?.addEventListener('click', async ()=>{
    const user = auth.currentUser; if(!user) return;
    const cpm           = $('#novoCPM').value.trim();
    const status        = $('#novoStatus').value;
    const dataFab       = $('#novoDataFab').value;
    const senhaCadeado  = $('#novoSenhaCadeado').value.trim();
    const modemLogin    = $('#novoModemLogin').value.trim();
    const modemSenha    = $('#novoModemSenha').value.trim();
    const numeroChip    = $('#novoNumeroChip').value.trim();
    const observacoes   = $('#novoDescricao').value.trim();

    try{
      const id = await criarRegistro({
        cpm, status, observacoes,
        dataFabricacao: dataFab,
        senhaCadeado, modemLogin, modemSenha, numeroChip,
        uid: user.uid, email: user.email
      });
      const msg = $('#criadoMsg'); if (msg) msg.textContent = `✅ Salvo: ${id}`;
      // limpa form + seleção
      $('#novoCPM').value='';
      $('#novoDescricao').value='';
      $('#novoDataFab').value='';
      $('#novoSenhaCadeado').value='';
      $('#novoModemLogin').value='';
      $('#novoModemSenha').value='';
      $('#novoNumeroChip').value='';
      selectedFiles = [];
      renderPreview();
      cacheDados = await listarUltimos(200);
      renderLista(aplicarFiltrosOrdenacao(cacheDados));
    }catch(e){ alert('Erro ao salvar: '+e.message); }
  });

  // BUSCAR por CPM (bloco acima)
  $('#btnBuscar')?.addEventListener('click', async ()=>{
    const cpm = ($('#buscaCPM')?.value||'').trim();
    if(!cpm) return;
    try{
      const data = await buscarPorCPM(cpm);
      const out = document.querySelector('#resultado');
      if(out) out.textContent = data ? JSON.stringify(data, null, 2) : 'Não encontrado.';
    }catch(e){ alert('Erro: '+e.message); }
  });
}

function renderLista(arr){
  const ul = $('#lista'); if(!ul) return;
  ul.innerHTML = '';
  arr.forEach(r=>{
    const fotosObj = normalizeFotos(r.fotos||[]);
    const thumbs = fotosObj.slice(0,5).map(f=>`<img src="${f.url}" alt="foto" />`).join('');
    const li = document.createElement('li');
    li.dataset.cpm = r.cpm;
    li.className = 'ticket';
    li.innerHTML = `
      <div class="item-row">
        <div class="left">
          <div><b>CPM: ${r.cpm||'(vazio)'}</b> <span class="tag">${r.status||''}</span></div>
          <div class="sub">
            Fab.: ${r.dataFabricacao || '-'} • Chip: ${r.numeroChip || '-'} • Cadeado: ${r.senhaCadeado || '-'}
          </div>
          <div class="sub">
            Modem: ${r.modemLogin ? (r.modemLogin + ' / ' + (r.modemSenha||'')) : '-'}
          </div>
          ${thumbs ? `<div class="thumbs" style="margin-top:.35rem">${thumbs}</div>`:''}
        </div>
        <div class="right">
          <select class="sel-status">
            <option ${r.status==='ONLINE'?'selected':''}>ONLINE</option>
            <option ${r.status==='EM ESTOQUE'?'selected':''}>EM ESTOQUE</option>
            <option ${r.status==='EM MANUTENÇÃO'?'selected':''}>EM MANUTENÇÃO</option>
          </select>
          <button class="btn-edit">Editar</button>
          <button class="btn-del">Excluir</button>
        </div>
      </div>
    `;
    ul.appendChild(li);
  });

  // Troca de status
  ul.onchange = async (e)=>{
    const sel = e.target.closest('.sel-status'); if(!sel) return;
    const cpm = e.target.closest('li')?.dataset?.cpm;
    try{
      await atualizarRegistro(cpm, { status: sel.value });
      cacheDados = await listarUltimos(200);
      renderLista(aplicarFiltrosOrdenacao(cacheDados));
    }catch(err){ alert('Erro ao atualizar: '+err.message); }
  };

  // Editar/Excluir
  ul.onclick = async (e)=>{
    const li = e.target.closest('li'); if(!li) return;
    const cpm = li.dataset.cpm;

    if (e.target.closest('.btn-del')){
      if(!confirm(`Excluir registro ${cpm}?`)) return;
      try{
        await excluirRegistro(cpm);
        cacheDados = await listarUltimos(200);
        renderLista(aplicarFiltrosOrdenacao(cacheDados));
      }catch(err){ alert('Erro ao excluir: '+err.message); }
      return;
    }

    if (e.target.closest('.btn-edit')){
      try{
        const data = await buscarPorCPM(cpm);
        if(!data) return alert('Registro não encontrado.');
        // preencher edição
        editFotos = normalizeFotos(data.fotos||[]);
        editNovasFiles = [];
        $('#editCPM').value = data.cpm;
        $('#editCPMShown').value = data.cpm;
        $('#editStatus').value = data.status||'ONLINE';
        $('#editDataFab').value = ymdToInput(data.dataFabricacao || '');
        $('#editSenhaCadeado').value = data.senhaCadeado || '';
        $('#editModemLogin').value = data.modemLogin || '';
        $('#editModemSenha').value = data.modemSenha || '';
        $('#editNumeroChip').value = data.numeroChip || '';
        $('#editObservacoes').value = data.observacoes || '';
        renderEditFotosExistentes();
        renderEditPreviewNovas();
        $('#editModal').showModal();
      }catch(err){ alert('Erro ao abrir edição: '+err.message); }
    }
  };
}

/* ===== Boot ===== */
const page = document.body.dataset.page;
if(page==='auth') initAuth();
if(page==='app')  initApp();
