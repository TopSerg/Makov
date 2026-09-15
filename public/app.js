(() => {
  const $ = (s, el=document) => el.querySelector(s);
  const $$ = (s, el=document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
  let people = [], relationships = [], peopleMap = new Map();

  const fullName = p => [p.last_name, p.first_name, p.middle_name].filter(Boolean).join(' ');
  const statusClass = p => p.confidence === 'unconfirmed' ? 'unconfirmed' : (p.information_level === 'minimal' ? 'limited' : 'confirmed');
  const statusText = p => statusClass(p) === 'unconfirmed' ? 'Неподтверждён' : statusClass(p) === 'limited' ? 'Мало информации' : 'Подтверждён';
  const years = p => [p.birth_display || '', p.death_display || ''].filter(Boolean).join(' — ');

  async function api(path, options={}) {
    const r = await fetch(path, options);
    if (!r.ok) {
      let msg = `${r.status}`;
      try { const j = await r.json(); msg = j.error || msg; } catch {}
      throw new Error(msg);
    }
    return r.json();
  }

  async function loadTree() {
    const data = await api('/.netlify/functions/tree');
    people = data.people || [];
    relationships = data.relationships || [];
    peopleMap = new Map(people.map(p => [p.id, p]));
  }

  function setActive(page) {
    $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.nav === (page === 'person' ? 'tree' : page)));
  }

  async function route() {
    const raw = location.hash.slice(1) || '/tree';
    const [_, page, id] = raw.split('/');
    setActive(page || 'tree');
    const app = $('#app');
    app.innerHTML = '<div class="empty">Загрузка…</div>';
    try {
      if ((page || 'tree') === 'tree') renderTree(app);
      else if (page === 'person') await renderPerson(app, id);
      else if (page === 'about') renderAbout(app);
      else location.hash = '#/tree';
    } catch (e) {
      app.innerHTML = `<section class="page"><div class="callout"><b>Ошибка загрузки:</b> ${esc(e.message)}</div><p class="muted">Проверь переменные SUPABASE_URL и SUPABASE_PUBLISHABLE_KEY в Netlify и права RLS в Supabase.</p></section>`;
    }
    app.focus();
  }

  function generationOf(p) {
    if (Number.isInteger(p.generation)) return p.generation;
    const m = String(p.birth_display || '').match(/(18|19|20)\\d{2}/);
    if (!m) return 0;
    const year = Number(m[0]);
    return Math.max(0, Math.min(8, Math.round((2002 - year) / 26)));
  }

  function generationTitle(g) {
    const titles = {
      0: 'Поколение 0 · мы и двоюродные',
      1: 'Поколение 1 · родители',
      2: 'Поколение 2 · бабушки и дедушки',
      3: 'Поколение 3 · прабабушки и прадедушки',
      4: 'Поколение 4',
      5: 'Поколение 5',
      6: 'Поколение 6'
    };
    return titles[g] || `Поколение ${g}`;
  }

  function branchCenter(path) {
    if (!path) return 0;
    let left = -4200, right = 4200;
    for (const ch of path) {
      const mid = (left + right) / 2;
      if (ch === 'P') right = mid;
      else if (ch === 'M') left = mid;
    }
    return (left + right) / 2;
  }

  function renderTree(app) {
    app.innerHTML = `<section class="hero"><div><div class="eyebrow">Supabase · Netlify</div><h1>Семейное древо</h1><p>Каждая горизонтальная строка — одно поколение. Отцовская и материнская линии разведены по разным секторам; внутри них ветви родителей также разделяются.</p></div><div class="meta-chip">${people.length} записей</div></section>
      <section class="tree-shell"><div class="tree-toolbar"><input id="treeSearch" placeholder="Найти родственника…" autocomplete="off"><button class="btn" id="fitTree">Показать всё</button><label class="btn"><input type="checkbox" id="showCandidates" checked> кандидаты</label><div class="legend"><span><i class="dot confirmed"></i>подтверждено</span><span><i class="dot limited"></i>мало сведений</span><span><i class="dot unconfirmed"></i>не подтверждено</span></div></div><div id="treeViewport"><svg class="tree-svg" aria-label="Генеалогическое древо"><g id="scene"></g></svg><div class="tree-hint">колесо — масштаб · перетаскивание — перемещение</div></div></section>`;

    const svg = $('.tree-svg'), scene = $('#scene'), vp = $('#treeViewport');
    const W=230, H=82, YS=170, CLUSTER_GAP=245;
    const allGenerations = people.map(generationOf);
    const maxGen = Math.max(0, ...allGenerations);
    let scale=.8, tx=vp.clientWidth/2, ty=90, dragging=false, last={x:0,y:0};

    function visiblePeople() {
      return people.filter(p => $('#showCandidates').checked || p.confidence !== 'unconfirmed');
    }

    function layout() {
      const groups = new Map();
      for (const p of visiblePeople()) {
        const g = generationOf(p);
        const path = p.lineage_path || '';
        const key = `${g}|${path}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
      }

      const pos = new Map();
      for (const [key, arr] of groups) {
        const [gRaw, path] = key.split('|');
        const g = Number(gRaw);
        arr.sort((a,b)=>fullName(a).localeCompare(fullName(b), 'ru'));
        const center = branchCenter(path);
        const offset = -((arr.length - 1) * CLUSTER_GAP) / 2;
        arr.forEach((p,i) => pos.set(p.id, {
          x: center + offset + i * CLUSTER_GAP,
          y: (maxGen - g) * YS,
          generation: g,
          path
        }));
      }
      return pos;
    }

    function apply(){ scene.setAttribute('transform', `translate(${tx} ${ty}) scale(${scale})`); }
    function trunc(s,n){ s=String(s||''); return esc(s.length>n ? s.slice(0,n-1)+'…' : s); }

    function draw(focus='') {
      const pos = layout();
      const ids = new Set([...pos.keys()]);
      if (!pos.size) { scene.innerHTML=''; return; }

      const ps=[...pos.values()];
      const minX=Math.min(...ps.map(p=>p.x-W/2))-360;
      const maxX=Math.max(...ps.map(p=>p.x+W/2))+180;
      const minY=Math.min(...ps.map(p=>p.y-H/2))-80;
      const maxY=Math.max(...ps.map(p=>p.y+H/2))+80;

      const generations=[...new Set(ps.map(p=>p.generation))].sort((a,b)=>b-a);
      const rows = generations.map(g => {
        const y=(maxGen-g)*YS;
        return `<g class="generation-guide"><line x1="${minX}" y1="${y+H/2+43}" x2="${maxX}" y2="${y+H/2+43}"/><text x="${minX+8}" y="${y-H/2-18}">${esc(generationTitle(g))}</text></g>`;
      }).join('');

      const mainDivider = `
        <g class="branch-guides">
          <line class="branch-divider main" x1="0" y1="${minY}" x2="0" y2="${maxY}"/>
          <text class="branch-title paternal" x="-2100" y="${minY+24}">ОТЦОВСКАЯ ВЕТВЬ</text>
          <text class="branch-title maternal" x="2100" y="${minY+24}">МАТЕРИНСКАЯ ВЕТВЬ</text>
          <line class="branch-divider secondary" x1="-2100" y1="${minY+45}" x2="-2100" y2="${(maxGen-2)*YS+H/2+42}"/>
          <line class="branch-divider secondary" x1="2100" y1="${minY+45}" x2="2100" y2="${(maxGen-2)*YS+H/2+42}"/>
        </g>`;

      const edgeHtml = relationships.filter(r => ids.has(r.person_a_id) && ids.has(r.person_b_id)).map(r => {
        const a=pos.get(r.person_a_id), b=pos.get(r.person_b_id); if(!a||!b) return '';
        const un = r.confidence === 'unconfirmed' ? 'unconfirmed' : '';
        if (r.relationship_type === 'spouse_of') {
          return `<path class="edge spouse ${un}" d="M ${a.x+W/2} ${a.y} L ${b.x-W/2} ${b.y}"/>`;
        }
        if (r.relationship_type !== 'parent_of') return '';
        const y1=a.y+H/2, y2=b.y-H/2, mid=(y1+y2)/2;
        return `<path class="edge ${un}" d="M ${a.x} ${y1} C ${a.x} ${mid}, ${b.x} ${mid}, ${b.x} ${y2}"/>`;
      }).join('');

      const nodeHtml = visiblePeople().map(p => {
        const q=pos.get(p.id), st=statusClass(p);
        const branch = p.lineage_path ? ` · ${p.lineage_path}` : '';
        return `<g class="node ${st} ${p.id===focus?'focused':''}" data-id="${p.id}" transform="translate(${q.x-W/2},${q.y-H/2})"><rect rx="14" width="${W}" height="${H}"/><text class="name" x="14" y="24">${trunc(fullName(p),28)}</text><text class="sub" x="14" y="45">${trunc(years(p)||p.birth_place||'',31)}</text><text class="tag" x="14" y="66">${trunc(`Поколение ${generationOf(p)}${branch}`,28)}</text></g>`;
      }).join('');

      scene.innerHTML=rows+mainDivider+edgeHtml+nodeHtml;
      $$('.node', scene).forEach(n=>n.onclick=()=>location.hash=`#/person/${n.dataset.id}`);
      apply();
    }

    function fit() {
      const pos=layout(); if(!pos.size) return;
      const ps=[...pos.values()];
      const minX=Math.min(...ps.map(p=>p.x-W/2))-380, maxX=Math.max(...ps.map(p=>p.x+W/2))+220;
      const minY=Math.min(...ps.map(p=>p.y-H/2))-100, maxY=Math.max(...ps.map(p=>p.y+H/2))+100;
      const bw=Math.max(1,maxX-minX), bh=Math.max(1,maxY-minY);
      scale=Math.min((vp.clientWidth-70)/bw,(vp.clientHeight-70)/bh,1);
      tx=vp.clientWidth/2-(minX+maxX)/2*scale;
      ty=vp.clientHeight/2-(minY+maxY)/2*scale;
      apply();
    }

    function center(id) {
      const p=peopleMap.get(id); if(!p) return;
      const q=layout().get(id); if(!q) return;
      scale=Math.max(scale,.95);
      tx=vp.clientWidth/2-q.x*scale;
      ty=vp.clientHeight/2-q.y*scale;
      draw(id);
    }

    svg.addEventListener('wheel', e=>{
      e.preventDefault();
      const rect=svg.getBoundingClientRect(), mx=e.clientX-rect.left, my=e.clientY-rect.top, old=scale;
      scale=Math.max(.28,Math.min(2.2,scale*(e.deltaY<0?1.1:.9)));
      tx=mx-(mx-tx)*(scale/old); ty=my-(my-ty)*(scale/old); apply();
    },{passive:false});
    vp.addEventListener('pointerdown',e=>{if(e.target.closest('.node'))return;dragging=true;last={x:e.clientX,y:e.clientY};vp.setPointerCapture(e.pointerId);vp.classList.add('dragging')});
    vp.addEventListener('pointermove',e=>{if(!dragging)return;tx+=e.clientX-last.x;ty+=e.clientY-last.y;last={x:e.clientX,y:e.clientY};apply();});
    vp.addEventListener('pointerup',()=>{dragging=false;vp.classList.remove('dragging')});
    $('#fitTree').onclick=fit;
    $('#showCandidates').onchange=()=>{draw();fit();};
    $('#treeSearch').oninput=e=>{
      const q=e.target.value.trim().toLowerCase();
      if(!q){draw();return;}
      const p=visiblePeople().find(x=>fullName(x).toLowerCase().includes(q));
      if(p) center(p.id);
    };
    draw(); setTimeout(fit,0);
  }

  async function renderPerson(app, id) {
    const d = await api(`/.netlify/functions/person?id=${encodeURIComponent(id)}`);
    const p = d.person;
    const rels = (d.relationships||[]).map(r => {
      const otherId = r.person_a_id === p.id ? r.person_b_id : r.person_a_id;
      return {r, other: peopleMap.get(otherId)};
    }).filter(x=>x.other);
    const eventHtml = (d.events||[]).map(e=>`<div class="research-item"><b>${esc(e.event_type)}</b><div>${esc(e.date_display||e.date_from||'')}</div><div class="small">${esc(e.place||'')}</div>${e.description?`<div>${esc(e.description)}</div>`:''}</div>`).join('');
    const srcs = (d.sources||[]).map(x=>x.source).filter(Boolean);
    const claims = (d.claims||[]).map(c=>`<div class="research-item"><b>${esc(c.predicate)}</b><div>${esc(c.value_text||c.note||'')}</div><div class="small">Достоверность: ${esc(c.confidence)}</div></div>`).join('');
    app.innerHTML = `<section class="page"><a class="backlink" href="#/tree">← Вернуться к древу</a><div class="page-head"><div><div class="eyebrow">Карточка человека</div><h1>${esc(fullName(p))}</h1></div><span class="status-pill ${statusClass(p)}">${statusText(p)}</span></div><div class="grid"><article class="card span-7"><h2>Что известно</h2>${p.biography?`<p>${esc(p.biography)}</p>`:'<p class="muted">Биография пока не заполнена.</p>'}</article><aside class="card span-5"><h2>Карточка</h2><dl class="kv"><dt>Рождение</dt><dd>${esc(p.birth_display||'не установлено')}</dd><dt>Место рождения</dt><dd>${esc(p.birth_place||'не установлено')}</dd><dt>Смерть</dt><dd>${esc(p.death_display||'нет данных')}</dd><dt>Место смерти</dt><dd>${esc(p.death_place||'нет данных')}</dd></dl></aside><article class="card span-6"><h2>Связи</h2><div class="relation-list">${rels.length?rels.map(({r,other})=>`<a class="relation-item" href="#/person/${other.id}"><b>${esc(fullName(other))}</b><div class="small">${esc(r.relationship_type)} · ${esc(r.confidence)}</div></a>`).join(''):'<div class="muted">Связи не внесены.</div>'}</div></article><article class="card span-6"><h2>События</h2>${eventHtml||'<div class="muted">События пока не внесены.</div>'}</article><article class="card span-12"><h2>Гипотезы / claims</h2>${claims||'<div class="muted">Нет активных гипотез.</div>'}</article><article class="card span-12"><h2>Источники</h2><div class="source-list">${srcs.length?srcs.map(s=>`<div class="source-item"><div class="small">${esc(s.source_type||'Источник')}</div>${s.url?`<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`:`<b>${esc(s.title)}</b>`}${s.archive_name?`<div class="small">${esc([s.archive_name,s.fond,s.inventory,s.file_number].filter(Boolean).join(' · '))}</div>`:''}</div>`).join(''):'<div class="muted">Источники пока не привязаны.</div>'}</div></article></div></section>`;
  }

  function renderAbout(app) {
    app.innerHTML = `<section class="page"><div class="eyebrow">Архитектура</div><h1>Supabase + Netlify</h1><div class="grid"><article class="card span-6"><h2>Данные</h2><p>Люди, связи, события, источники, гипотезы и медиа хранятся в Supabase. Доступ регулируется Row Level Security.</p></article><article class="card span-6"><h2>Сайт</h2><p>Netlify отдаёт статический интерфейс и серверные функции. Функции обращаются к Supabase с publishable key, поэтому RLS остаётся главным уровнем защиты.</p></article></div></section>`;
  }

  function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2600);}
  $('#mobileNav').onclick=()=>$('.nav').classList.toggle('open');
  document.addEventListener('click',e=>{if(!e.target.closest('.topbar'))$('.nav').classList.remove('open')});
  loadTree().then(()=>{addEventListener('hashchange',route);route();}).catch(e=>{ $('#app').innerHTML=`<section class="page"><div class="callout"><b>Не удалось подключиться к базе:</b> ${esc(e.message)}</div><p>Проверь переменные Netlify и RLS в Supabase.</p></section>`; });
})();
