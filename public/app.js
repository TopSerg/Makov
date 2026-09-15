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

  function inferGenerations() {
    const parentEdges = relationships.filter(r => r.relationship_type === 'parent_of');
    const parents = new Map(), children = new Map();
    for (const p of people) { parents.set(p.id, []); children.set(p.id, []); }
    for (const r of parentEdges) {
      if (!peopleMap.has(r.person_a_id) || !peopleMap.has(r.person_b_id)) continue;
      parents.get(r.person_b_id).push(r.person_a_id);
      children.get(r.person_a_id).push(r.person_b_id);
    }
    const roots = people.filter(p => (parents.get(p.id) || []).length === 0).map(p => p.id);
    const level = new Map();
    const q = roots.map(id => [id, 0]);
    while (q.length) {
      const [id, l] = q.shift();
      if (level.has(id) && level.get(id) >= l) continue;
      level.set(id, l);
      for (const c of children.get(id) || []) q.push([c, l + 1]);
    }
    for (const p of people) if (!level.has(p.id)) level.set(p.id, 0);
    return level;
  }

  function renderTree(app) {
    app.innerHTML = `<section class="hero"><div><div class="eyebrow">Supabase · Netlify</div><h1>Семейное древо</h1><p>Нажмите на человека, чтобы открыть карточку. Жёлтым отмечены родственники, о которых мало данных; красным — неподтверждённые.</p></div><div class="meta-chip">${people.length} записей</div></section>
      <section class="tree-shell"><div class="tree-toolbar"><input id="treeSearch" placeholder="Найти родственника…" autocomplete="off"><button class="btn" id="fitTree">Показать всё</button><label class="btn"><input type="checkbox" id="showCandidates" checked> кандидаты</label><div class="legend"><span><i class="dot confirmed"></i>подтверждено</span><span><i class="dot limited"></i>мало сведений</span><span><i class="dot unconfirmed"></i>не подтверждено</span></div></div><div id="treeViewport"><svg class="tree-svg" aria-label="Генеалогическое древо"><g id="scene"></g></svg><div class="tree-hint">колесо — масштаб · перетаскивание — перемещение</div></div></section>`;

    const svg = $('.tree-svg'), scene = $('#scene'), vp = $('#treeViewport');
    const levels = inferGenerations();
    const W=230, H=82, XS=270, YS=165;
    let scale=.8, tx=vp.clientWidth/2, ty=90, dragging=false, last={x:0,y:0};

    function visiblePeople() { return people.filter(p => $('#showCandidates').checked || p.confidence !== 'unconfirmed'); }
    function layout() {
      const byLevel = new Map();
      for (const p of visiblePeople()) {
        const l = levels.get(p.id) || 0;
        if (!byLevel.has(l)) byLevel.set(l, []);
        byLevel.get(l).push(p);
      }
      const pos = new Map();
      [...byLevel.entries()].sort((a,b)=>a[0]-b[0]).forEach(([l, arr]) => {
        arr.sort((a,b)=>fullName(a).localeCompare(fullName(b), 'ru'));
        const offset = -((arr.length-1)*XS)/2;
        arr.forEach((p,i)=>pos.set(p.id,{x:offset+i*XS,y:l*YS}));
      });
      return pos;
    }
    function apply(){ scene.setAttribute('transform', `translate(${tx} ${ty}) scale(${scale})`); }
    function trunc(s,n){ s=String(s||''); return esc(s.length>n ? s.slice(0,n-1)+'…' : s); }
    function draw(focus='') {
      const pos = layout();
      const ids = new Set([...pos.keys()]);
      const edgeHtml = relationships.filter(r => ids.has(r.person_a_id) && ids.has(r.person_b_id)).map(r => {
        const a=pos.get(r.person_a_id), b=pos.get(r.person_b_id); if(!a||!b) return '';
        const un = r.confidence === 'unconfirmed' ? 'unconfirmed' : '';
        if (r.relationship_type === 'spouse_of') return `<path class="edge spouse ${un}" d="M ${a.x+W/2} ${a.y} L ${b.x-W/2} ${b.y}"/>`;
        if (r.relationship_type !== 'parent_of') return '';
        const y1=a.y+H/2, y2=b.y-H/2, mid=(y1+y2)/2;
        return `<path class="edge ${un}" d="M ${a.x} ${y1} C ${a.x} ${mid}, ${b.x} ${mid}, ${b.x} ${y2}"/>`;
      }).join('');
      const nodeHtml = visiblePeople().map(p => {
        const q=pos.get(p.id), st=statusClass(p);
        return `<g class="node ${st} ${p.id===focus?'focused':''}" data-id="${p.id}" transform="translate(${q.x-W/2},${q.y-H/2})"><rect rx="14" width="${W}" height="${H}"/><text class="name" x="14" y="24">${trunc(fullName(p),28)}</text><text class="sub" x="14" y="45">${trunc(years(p)||p.birth_place||'',31)}</text><text class="tag" x="14" y="66">${trunc(statusText(p),28)}</text></g>`;
      }).join('');
      scene.innerHTML=edgeHtml+nodeHtml;
      $$('.node', scene).forEach(n=>n.onclick=()=>location.hash=`#/person/${n.dataset.id}`);
      apply();
    }
    function fit() {
      const pos=layout(); if(!pos.size) return;
      const ps=[...pos.values()]; const minX=Math.min(...ps.map(p=>p.x-W/2)), maxX=Math.max(...ps.map(p=>p.x+W/2)), minY=Math.min(...ps.map(p=>p.y-H/2)), maxY=Math.max(...ps.map(p=>p.y+H/2));
      const bw=Math.max(1,maxX-minX), bh=Math.max(1,maxY-minY);
      scale=Math.min((vp.clientWidth-70)/bw,(vp.clientHeight-70)/bh,1);
      tx=vp.clientWidth/2-(minX+maxX)/2*scale; ty=vp.clientHeight/2-(minY+maxY)/2*scale; apply();
    }
    function center(id) { const p=peopleMap.get(id); if(!p) return; const q=layout().get(id); if(!q) return; scale=Math.max(scale,.95); tx=vp.clientWidth/2-q.x*scale; ty=vp.clientHeight/2-q.y*scale; draw(id); }
    svg.addEventListener('wheel', e=>{e.preventDefault(); const rect=svg.getBoundingClientRect(), mx=e.clientX-rect.left, my=e.clientY-rect.top, old=scale; scale=Math.max(.28,Math.min(2.2,scale*(e.deltaY<0?1.1:.9))); tx=mx-(mx-tx)*(scale/old); ty=my-(my-ty)*(scale/old); apply();},{passive:false});
    vp.addEventListener('pointerdown',e=>{if(e.target.closest('.node'))return;dragging=true;last={x:e.clientX,y:e.clientY};vp.setPointerCapture(e.pointerId)});
    vp.addEventListener('pointermove',e=>{if(!dragging)return;tx+=e.clientX-last.x;ty+=e.clientY-last.y;last={x:e.clientX,y:e.clientY};apply();});
    vp.addEventListener('pointerup',()=>dragging=false);
    $('#fitTree').onclick=fit; $('#showCandidates').onchange=()=>{draw();fit();};
    $('#treeSearch').oninput=e=>{const q=e.target.value.trim().toLowerCase(); if(!q){draw();return;} const p=visiblePeople().find(x=>fullName(x).toLowerCase().includes(q)); if(p) center(p.id);};
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
