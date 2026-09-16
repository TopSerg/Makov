(() => {
  const $ = (s, el=document) => el.querySelector(s);
  const $$ = (s, el=document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
  let people = [], relationships = [], peopleMap = new Map();
  let authConfig = null, authSession = null, authUser = null, viewer = null;
  let hashListenerInstalled = false;
  const SESSION_KEY = "makov-family-session";

  const fullName = p => [p.last_name, p.first_name, p.middle_name].filter(Boolean).join(' ');
  const statusClass = p => p.confidence === 'unconfirmed' ? 'unconfirmed' : (p.information_level === 'minimal' ? 'limited' : 'confirmed');
  const statusText = p => statusClass(p) === 'unconfirmed' ? 'Неподтверждён' : statusClass(p) === 'limited' ? 'Мало информации' : 'Подтверждён';
  const years = p => [p.birth_display || '', p.death_display || ''].filter(Boolean).join(' — ');

  function readStoredSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    } catch {
      return null;
    }
  }

  function saveSession(session) {
    authSession = session;
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  }

  function setLoggedInUi(loggedIn) {
    document.body.classList.toggle("logged-out", !loggedIn);
  }

  async function loadAuthConfig() {
    const r = await fetch("/.netlify/functions/auth-config", { cache: "no-store" });
    if (!r.ok) throw new Error("Не удалось загрузить конфигурацию авторизации");
    authConfig = await r.json();
  }

  async function authRest(path, options={}) {
    const headers = {
      apikey: authConfig.publishableKey,
      "content-type": "application/json",
      ...(options.headers || {})
    };
    return fetch(`${authConfig.url}/auth/v1${path}`, { ...options, headers });
  }

  async function refreshSession() {
    if (!authSession?.refresh_token) return false;
    const r = await authRest("/token?grant_type=refresh_token", {
      method: "POST",
      body: JSON.stringify({ refresh_token: authSession.refresh_token })
    });
    if (!r.ok) {
      saveSession(null);
      authUser = null;
      return false;
    }
    const data = await r.json();
    saveSession(data);
    authUser = data.user || authUser;
    return true;
  }

  async function ensureAccessToken() {
    if (!authSession?.access_token) return null;
    const expiresAt = Number(authSession.expires_at || 0) * 1000;
    if (expiresAt && expiresAt < Date.now() + 60000) {
      const ok = await refreshSession();
      if (!ok) return null;
    }
    return authSession.access_token;
  }

  async function validateSession() {
    if (!authSession?.access_token) return null;
    let token = await ensureAccessToken();
    if (!token) return null;

    let r = await authRest("/user", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` }
    });

    if (r.status === 401 && await refreshSession()) {
      token = authSession.access_token;
      r = await authRest("/user", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` }
      });
    }

    if (!r.ok) {
      saveSession(null);
      return null;
    }
    return r.json();
  }

  async function signIn(email, password) {
    const r = await authRest("/token?grant_type=password", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(data.error_description || data.msg || "Неверный email или пароль");
    }
    saveSession(data);
    authUser = data.user || null;
  }

  async function signUp(email, password, displayName, accessMessage="") {
    const r = await authRest("/signup", {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        data: {
          display_name: displayName,
          access_message: accessMessage
        }
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(data.msg || data.error_description || "Не удалось создать аккаунт");
    }
    return data;
  }

  async function submitAccessRequest(userId, email, displayName, message) {
    const r = await fetch("/.netlify/functions/request-access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        email,
        display_name: displayName,
        message
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Не удалось отправить заявку");
    return data;
  }

  async function signOut() {
    const token = authSession?.access_token;
    if (token) {
      try {
        await authRest("/logout", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: "{}"
        });
      } catch {}
    }
    saveSession(null);
    authUser = null;
    viewer = null;
    people = [];
    relationships = [];
    peopleMap = new Map();
    setLoggedInUi(false);
    renderLogin();
  }

  function renderLogin(message="") {
    setLoggedInUi(false);
    const app = $("#app");
    app.innerHTML = `<section class="auth-shell"><div class="auth-card"><div class="auth-lock">🔒</div><div class="eyebrow">Закрытый семейный архив</div><h1>Вход</h1><p>Данные семейного древа доступны только пользователям, которым администратор выдал доступ.</p>${message ? `<div class="auth-error">${esc(message)}</div>` : ""}<form class="auth-form" id="loginForm"><div class="auth-field"><label for="loginEmail">Email</label><input id="loginEmail" name="email" type="email" autocomplete="username" required></div><div class="auth-field"><label for="loginPassword">Пароль</label><input id="loginPassword" name="password" type="password" autocomplete="current-password" required></div><button class="btn primary" id="loginSubmit" type="submit">Войти</button></form><div class="auth-switch">Нет аккаунта? <button class="link-btn" id="showRegister" type="button">Подать заявку на доступ</button></div></div></section>`;

    $("#loginForm").onsubmit = async (e) => {
      e.preventDefault();
      const button = $("#loginSubmit");
      const email = $("#loginEmail").value.trim();
      const password = $("#loginPassword").value;
      button.disabled = true;
      button.textContent = "Вход…";
      try {
        await signIn(email, password);
        await enterAuthenticatedApp();
      } catch (error) {
        renderLogin(error.message);
      }
    };
    $("#showRegister").onclick = () => renderRegister();
  }

  function renderRegister(message="", success=false) {
    setLoggedInUi(false);
    const app = $("#app");
    if (success) {
      app.innerHTML = `<section class="auth-shell"><div class="auth-card"><div class="auth-lock">✓</div><div class="eyebrow">Заявка отправлена</div><h1>Ждём подтверждения</h1><p>Аккаунт создан, а администратор получил заявку на доступ. После одобрения можно будет войти через обычную форму. Если Supabase попросил подтвердить email, сначала перейдите по ссылке из письма.</p><button class="btn primary" id="backToLogin" type="button">К входу</button></div></section>`;
      $("#backToLogin").onclick = () => renderLogin();
      return;
    }

    app.innerHTML = `<section class="auth-shell"><div class="auth-card"><div class="auth-lock">✉</div><div class="eyebrow">Регистрация</div><h1>Запросить доступ</h1><p>Создайте аккаунт и коротко напишите, кто вы. Доступ к дереву появится только после одобрения администратором.</p>${message ? `<div class="auth-error">${esc(message)}</div>` : ""}<form class="auth-form" id="registerForm"><div class="auth-field"><label for="registerName">Имя</label><input id="registerName" type="text" autocomplete="name" maxlength="120" required></div><div class="auth-field"><label for="registerEmail">Email</label><input id="registerEmail" type="email" autocomplete="email" required></div><div class="auth-field"><label for="registerPassword">Пароль</label><input id="registerPassword" type="password" autocomplete="new-password" minlength="8" required></div><div class="auth-field"><label for="registerPassword2">Повторите пароль</label><input id="registerPassword2" type="password" autocomplete="new-password" minlength="8" required></div><div class="auth-field"><label for="registerMessage">Кто вы / как связаны с семьёй</label><textarea id="registerMessage" rows="4" maxlength="1000" placeholder="Например: двоюродный брат по линии Зиновьевых"></textarea></div><button class="btn primary" id="registerSubmit" type="submit">Создать аккаунт и отправить заявку</button></form><div class="auth-switch">Уже есть аккаунт? <button class="link-btn" id="showLogin" type="button">Войти</button></div></div></section>`;

    $("#showLogin").onclick = () => renderLogin();
    $("#registerForm").onsubmit = async (e) => {
      e.preventDefault();
      const displayName = $("#registerName").value.trim();
      const email = $("#registerEmail").value.trim();
      const password = $("#registerPassword").value;
      const password2 = $("#registerPassword2").value;
      const messageText = $("#registerMessage").value.trim();
      if (password !== password2) {
        renderRegister("Пароли не совпадают");
        return;
      }

      const button = $("#registerSubmit");
      button.disabled = true;
      button.textContent = "Создание аккаунта…";

      try {
        const data = await signUp(email, password, displayName, messageText);
        const user = data.user;
        if (!user?.id) {
          throw new Error("Supabase не вернул идентификатор нового пользователя.");
        }
        await submitAccessRequest(user.id, email, displayName, messageText);
        renderRegister("", true);
      } catch (error) {
        renderRegister(error.message);
      }
    };
  }

  function renderAccessPending() {
    setLoggedInUi(true);
    const app = $("#app");
    app.innerHTML = `<section class="auth-shell"><div class="auth-card"><div class="auth-lock">🔐</div><div class="eyebrow">Аккаунт подтверждён</div><h1>Доступ ещё не выдан</h1><p>Вход выполнен, но этот аккаунт пока не добавлен в список членов семейного архива.</p><button class="btn" id="pendingLogout" type="button">Выйти</button></div></section>`;
    $("#pendingLogout").onclick = signOut;
  }

  async function api(path, options={}, retry=true) {
    const token = await ensureAccessToken();
    if (!token) {
      await signOut();
      throw new Error("Сессия истекла");
    }

    const headers = {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`
    };
    let r = await fetch(path, { ...options, headers });

    if (r.status === 401 && retry && await refreshSession()) {
      return api(path, options, false);
    }

    if (!r.ok) {
      let msg = `${r.status}`;
      try { const j = await r.json(); msg = j.error || msg; } catch {}
      const err = new Error(msg);
      err.status = r.status;
      throw err;
    }
    return r.json();
  }

  async function loadTree() {
    const data = await api('/.netlify/functions/tree');
    people = data.people || [];
    relationships = data.relationships || [];
    viewer = data.viewer || null;
    peopleMap = new Map(people.map(p => [p.id, p]));
    const accessNav = $("#accessNav");
    if (accessNav) accessNav.hidden = viewer?.role !== "admin";
  }

  function setActive(page) {
    $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.nav === (page === 'person' ? 'tree' : page)));
  }

  async function route() {
    if (!authUser) {
      renderLogin();
      return;
    }
    const raw = location.hash.slice(1) || '/tree';
    const [_, page, id] = raw.split('/');
    setActive(page || 'tree');
    const app = $('#app');
    app.innerHTML = '<div class="empty">Загрузка…</div>';
    try {
      if ((page || 'tree') === 'tree') renderTree(app);
      else if (page === 'person') await renderPerson(app, id);
      else if (page === 'questions') await renderQuestions(app);
      else if (page === 'about') renderAbout(app);
      else if (page === 'access') {
        if (viewer?.role !== "admin") location.hash = '#/tree';
        else await renderAccessRequests(app);
      }
      else location.hash = '#/tree';
    } catch (e) {
      app.innerHTML = `<section class="page"><div class="callout"><b>Ошибка загрузки:</b> ${esc(e.message)}</div><p class="muted">Проверь переменные SUPABASE_URL и SUPABASE_PUBLISHABLE_KEY в Netlify и права RLS в Supabase.</p></section>`;
    }
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
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
    app.innerHTML = `<section class="hero"><div><div class="eyebrow">Supabase · Netlify</div><h1>Семейное древо</h1><p>Каждая горизонтальная строка — одно поколение. Супруги всегда образуют один семейный блок, а разделители начинаются только выше пары — там, где ветвь действительно расходится на родителей.</p></div><div class="meta-chip">${people.length} записей</div></section>
      <section class="tree-shell"><div class="tree-toolbar"><input id="treeSearch" placeholder="Найти родственника…" autocomplete="off"><button class="btn" id="fitTree">Показать всё</button><label class="btn"><input type="checkbox" id="showCandidates" checked> кандидаты</label><div class="legend"><span><i class="dot confirmed"></i>подтверждено</span><span><i class="dot limited"></i>мало сведений</span><span><i class="dot unconfirmed"></i>не подтверждено</span></div></div><div id="treeViewport"><svg class="tree-svg" aria-label="Генеалогическое древо"><g id="scene"></g></svg><div class="tree-hint">колесо — масштаб · перетаскивание — перемещение</div></div></section>`;

    const svg = $('.tree-svg'), scene = $('#scene'), vp = $('#treeViewport');
    const W=230, H=82, YS=172, PERSON_GAP=18, UNIT_GAP=82;
    const allGenerations = people.map(generationOf);
    const maxGen = Math.max(0, ...allGenerations);
    let scale=.8, tx=vp.clientWidth/2, ty=90, dragging=false, last={x:0,y:0};

    const spouseEdges = relationships.filter(r => r.relationship_type === 'spouse_of');

    function visiblePeople() {
      return people.filter(p => $('#showCandidates').checked || p.confidence !== 'unconfirmed');
    }

    function coupleComponents(arr) {
      const ids = new Set(arr.map(p=>p.id));
      const parent = new Map(arr.map(p=>[p.id,p.id]));
      const find = x => {
        let r=x;
        while(parent.get(r)!==r) r=parent.get(r);
        while(parent.get(x)!==x){ const n=parent.get(x); parent.set(x,r); x=n; }
        return r;
      };
      const unite=(a,b)=>{
        const ra=find(a), rb=find(b);
        if(ra!==rb) parent.set(rb,ra);
      };
      for(const r of spouseEdges){
        if(ids.has(r.person_a_id) && ids.has(r.person_b_id)) unite(r.person_a_id,r.person_b_id);
      }
      const groups=new Map();
      for(const p of arr){
        const root=find(p.id);
        if(!groups.has(root)) groups.set(root,[]);
        groups.get(root).push(p);
      }
      return [...groups.values()];
    }

    function unitPath(unit, g) {
      const paths=[...new Set(unit.map(p=>p.lineage_path || ''))];
      if(paths.length===1) return paths[0];

      // The focal parents are a married pair whose personal P/M paths differ,
      // but visually they must remain one central family unit.
      if(g===1 && paths.includes('P') && paths.includes('M')) return '';

      // Otherwise keep the longest common prefix so a spouse pair stays together.
      let prefix=paths[0] || '';
      for(const p of paths.slice(1)){
        let i=0;
        while(i<prefix.length && i<p.length && prefix[i]===p[i]) i++;
        prefix=prefix.slice(0,i);
      }
      return prefix;
    }

    function unitsForLayout() {
      const byGeneration=new Map();
      for(const p of visiblePeople()){
        const g=generationOf(p);
        if(!byGeneration.has(g)) byGeneration.set(g,[]);
        byGeneration.get(g).push(p);
      }

      const units=[];
      for(const [g, arr] of byGeneration){
        for(const members of coupleComponents(arr)){
          members.sort((a,b)=>{
            const ao=Number.isFinite(a.layout_order) ? a.layout_order : null;
            const bo=Number.isFinite(b.layout_order) ? b.layout_order : null;
            if(ao!==null || bo!==null){
              if(ao===null) return 1;
              if(bo===null) return -1;
              if(ao!==bo) return ao-bo;
            }
            const sexRank = x => x.sex==='male' ? 0 : x.sex==='female' ? 1 : 2;
            return sexRank(a)-sexRank(b) || fullName(a).localeCompare(fullName(b),'ru');
          });
          units.push({
            generation:g,
            path:unitPath(members,g),
            members
          });
        }
      }
      return units;
    }

    function layout() {
      const units=unitsForLayout();
      const groups=new Map();
      for(const unit of units){
        const key=`${unit.generation}|${unit.path}`;
        if(!groups.has(key)) groups.set(key,[]);
        groups.get(key).push(unit);
      }

      const pos=new Map();
      for(const [key, groupUnits] of groups){
        const [gRaw,path]=key.split('|');
        const g=Number(gRaw);
        groupUnits.sort((a,b)=>{
          const orderOf = unit => {
            const values=unit.members.map(p=>p.layout_order).filter(Number.isFinite);
            return values.length ? Math.min(...values) : null;
          };
          const ao=orderOf(a), bo=orderOf(b);
          if(ao!==null || bo!==null){
            if(ao===null) return 1;
            if(bo===null) return -1;
            if(ao!==bo) return ao-bo;
          }
          return fullName(a.members[0]).localeCompare(fullName(b.members[0]),'ru');
        });

        const widths=groupUnits.map(u=>u.members.length*W+(u.members.length-1)*PERSON_GAP);
        const totalWidth=widths.reduce((s,x)=>s+x,0)+Math.max(0,groupUnits.length-1)*UNIT_GAP;
        let cursor=branchCenter(path)-totalWidth/2;

        groupUnits.forEach((unit,ui)=>{
          unit.members.forEach((p,mi)=>{
            const x=cursor+mi*(W+PERSON_GAP)+W/2;
            pos.set(p.id,{
              x,
              y:(maxGen-g)*YS,
              generation:g,
              path
            });
          });
          cursor+=widths[ui]+UNIT_GAP;
        });
      }
      return pos;
    }

    function apply(){ scene.setAttribute('transform', `translate(${tx} ${ty}) scale(${scale})`); }
    function trunc(s,n){ s=String(s||''); return esc(s.length>n ? s.slice(0,n-1)+'…' : s); }

    function subtreePresent(prefix) {
      return visiblePeople().some(p => (p.lineage_path || '').startsWith(prefix));
    }

    function recursiveDividers(minY) {
      const paths=[...new Set(visiblePeople().map(p=>p.lineage_path || '').filter(Boolean))];
      const prefixes=new Set(['']);
      for(const path of paths){
        for(let i=0;i<path.length;i++) prefixes.add(path.slice(0,i));
      }

      const lines=[];
      for(const prefix of prefixes){
        const left=prefix+'P', right=prefix+'M';
        if(!subtreePresent(left) || !subtreePresent(right)) continue;

        // A prefix of length d represents the couple one generation below
        // the two parent branches. Stop the separator above that couple row.
        const coupleGeneration=prefix.length+1;
        if(coupleGeneration>maxGen) continue;
        const yEnd=(maxGen-coupleGeneration)*YS-H/2-20;
        const cls=prefix==='' ? 'branch-divider main' : 'branch-divider secondary';
        lines.push(`<line class="${cls}" x1="${branchCenter(prefix)}" y1="${minY}" x2="${branchCenter(prefix)}" y2="${yEnd}"/>`);
      }
      return lines.join('');
    }

    function draw(focus='') {
      const pos=layout();
      const ids=new Set([...pos.keys()]);
      if(!pos.size){ scene.innerHTML=''; return; }

      const ps=[...pos.values()];
      const minX=Math.min(...ps.map(p=>p.x-W/2))-360;
      const maxX=Math.max(...ps.map(p=>p.x+W/2))+220;
      const minY=Math.min(...ps.map(p=>p.y-H/2))-105;
      const maxY=Math.max(...ps.map(p=>p.y+H/2))+85;

      const generations=[...new Set(ps.map(p=>p.generation))].sort((a,b)=>b-a);
      const rows=generations.map(g=>{
        const y=(maxGen-g)*YS;
        return `<g class="generation-guide"><line x1="${minX}" y1="${y+H/2+43}" x2="${maxX}" y2="${y+H/2+43}"/><text x="${minX+8}" y="${y-H/2-18}">${esc(generationTitle(g))}</text></g>`;
      }).join('');

      const branchGuides=`
        <g class="branch-guides">
          ${recursiveDividers(minY)}
          ${subtreePresent('P') ? `<text class="branch-title paternal" x="${branchCenter('P')}" y="${minY+24}">ОТЦОВСКАЯ ВЕТВЬ</text>` : ''}
          ${subtreePresent('M') ? `<text class="branch-title maternal" x="${branchCenter('M')}" y="${minY+24}">МАТЕРИНСКАЯ ВЕТВЬ</text>` : ''}
        </g>`;

      const edgeHtml=relationships.filter(r=>ids.has(r.person_a_id)&&ids.has(r.person_b_id)).map(r=>{
        const a=pos.get(r.person_a_id), b=pos.get(r.person_b_id);
        if(!a||!b) return '';
        const un=r.confidence==='unconfirmed' ? 'unconfirmed' : '';

        if(r.relationship_type==='spouse_of'){
          const left=a.x<=b.x?a:b, right=a.x<=b.x?b:a;
          return `<path class="edge spouse ${un}" d="M ${left.x+W/2} ${left.y} L ${right.x-W/2} ${right.y}"/>`;
        }

        if(r.relationship_type!=='parent_of') return '';
        const y1=a.y+H/2, y2=b.y-H/2, mid=(y1+y2)/2;
        return `<path class="edge ${un}" d="M ${a.x} ${y1} C ${a.x} ${mid}, ${b.x} ${mid}, ${b.x} ${y2}"/>`;
      }).join('');

      const nodeHtml=visiblePeople().map(p=>{
        const q=pos.get(p.id), st=statusClass(p);
        const branch=p.lineage_path ? ` · ${p.lineage_path}` : '';
        return `<g class="node ${st} ${p.id===focus?'focused':''}" data-id="${p.id}" transform="translate(${q.x-W/2},${q.y-H/2})"><rect rx="14" width="${W}" height="${H}"/><text class="name" x="14" y="24">${trunc(fullName(p),28)}</text><text class="sub" x="14" y="45">${trunc(years(p)||p.birth_place||'',31)}</text><text class="tag" x="14" y="66">${trunc(`Поколение ${generationOf(p)}${branch}`,28)}</text></g>`;
      }).join('');

      scene.innerHTML=rows+branchGuides+edgeHtml+nodeHtml;
      $$('.node',scene).forEach(n=>n.onclick=()=>location.hash=`#/person/${n.dataset.id}`);
      apply();
    }

    function fit(){
      const pos=layout(); if(!pos.size) return;
      const ps=[...pos.values()];
      const minX=Math.min(...ps.map(p=>p.x-W/2))-390, maxX=Math.max(...ps.map(p=>p.x+W/2))+240;
      const minY=Math.min(...ps.map(p=>p.y-H/2))-120, maxY=Math.max(...ps.map(p=>p.y+H/2))+110;
      const bw=Math.max(1,maxX-minX), bh=Math.max(1,maxY-minY);
      scale=Math.min((vp.clientWidth-70)/bw,(vp.clientHeight-70)/bh,1);
      tx=vp.clientWidth/2-(minX+maxX)/2*scale;
      ty=vp.clientHeight/2-(minY+maxY)/2*scale;
      apply();
    }

    function center(id){
      const p=peopleMap.get(id); if(!p) return;
      const q=layout().get(id); if(!q) return;
      scale=Math.max(scale,.95);
      tx=vp.clientWidth/2-q.x*scale;
      ty=vp.clientHeight/2-q.y*scale;
      draw(id);
    }

    svg.addEventListener('wheel',e=>{
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
    let d;
    try {
      d = await api(`/.netlify/functions/person?id=${encodeURIComponent(id)}`);
    } catch (error) {
      // Never leave a clicked relative on an empty page: the tree payload
      // already contains enough public data for a basic card.
      const basic = peopleMap.get(id);
      if (!basic) throw error;
      d = {
        person: basic,
        relationships: relationships.filter(r => r.person_a_id === id || r.person_b_id === id),
        events: [],
        sources: [],
        claims: [],
        media: []
      };
    }

    const p=d.person;
    const rels=(d.relationships||[]).map(r=>{
      const otherId=r.person_a_id===p.id ? r.person_b_id : r.person_a_id;
      return {r,other:peopleMap.get(otherId)};
    }).filter(x=>x.other);

    const relationLabel=(r,other)=>{
      if(r.relationship_type==='spouse_of') return 'супруг(а)';
      if(r.relationship_type==='parent_of'){
        return r.person_a_id===p.id ? 'ребёнок' : 'родитель';
      }
      return r.relationship_type;
    };

    const eventHtml=(d.events||[]).map(e=>`<div class="research-item"><b>${esc(e.event_type)}</b><div>${esc(e.date_display||e.date_from||'')}</div><div class="small">${esc(e.place||'')}</div>${e.description?`<div>${esc(e.description)}</div>`:''}</div>`).join('');

    const srcs=(d.sources||[])
      .flatMap(x=>Array.isArray(x.source)?x.source:[x.source])
      .filter(Boolean);

    const claims=(d.claims||[]).map(cl=>`<div class="research-item"><b>${esc(cl.predicate)}</b><div>${esc(cl.value_text||cl.note||'')}</div><div class="small">Достоверность: ${esc(cl.confidence)}</div></div>`).join('');

    const generation = Number.isInteger(p.generation) ? p.generation : generationOf(p);
    const lineage = p.lineage_path || 'центральная ветвь';

    app.innerHTML=`<section class="page">
      <a class="backlink" href="#/tree">← Вернуться к древу</a>
      <div class="page-head"><div><div class="eyebrow">Карточка человека</div><h1>${esc(fullName(p))}</h1><div class="chip-row"><span class="chip">Поколение ${generation}</span><span class="chip">Ветвь: ${esc(lineage)}</span></div></div><span class="status-pill ${statusClass(p)}">${statusText(p)}</span></div>
      <div class="grid">
        <article class="card span-7"><h2>Что известно</h2>${p.biography?`<p>${esc(p.biography)}</p>`:'<p class="muted">Биография пока не заполнена.</p>'}</article>
        <aside class="card span-5"><h2>Карточка</h2><dl class="kv"><dt>Рождение</dt><dd>${esc(p.birth_display||'не установлено')}</dd><dt>Место рождения</dt><dd>${esc(p.birth_place||'не установлено')}</dd><dt>Смерть</dt><dd>${esc(p.death_display||'нет данных')}</dd><dt>Место смерти</dt><dd>${esc(p.death_place||'нет данных')}</dd></dl></aside>
        <article class="card span-6"><h2>Семейные связи</h2><div class="relation-list">${rels.length?rels.map(({r,other})=>`<a class="relation-item" href="#/person/${other.id}"><b>${esc(fullName(other))}</b><div class="small">${esc(relationLabel(r,other))} · ${esc(r.confidence)}</div></a>`).join(''):'<div class="muted">Связи не внесены.</div>'}</div></article>
        <article class="card span-6"><h2>События</h2>${eventHtml||'<div class="muted">События пока не внесены.</div>'}</article>
        <article class="card span-12"><h2>Гипотезы</h2>${claims||'<div class="muted">Нет активных гипотез.</div>'}</article>
        <article class="card span-12"><h2>Источники</h2><div class="source-list">${srcs.length?srcs.map(s=>`<div class="source-item"><div class="small">${esc(s.source_type||'Источник')}</div>${s.url?`<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`:`<b>${esc(s.title)}</b>`}${s.archive_name?`<div class="small">${esc([s.archive_name,s.fond,s.inventory,s.file_number].filter(Boolean).join(' · '))}</div>`:''}</div>`).join(''):'<div class="muted">Источники пока не привязаны.</div>'}</div></article>
      </div>
    </section>`;
  }

  const questionPriorityWeight = { "Критический": 0, "Высокий": 1, "Средний": 2, "Низкий": 3 };

  function questionPriorityClass(priority) {
    return priority === "Критический" ? "critical"
      : priority === "Высокий" ? "high"
      : priority === "Средний" ? "medium"
      : "low";
  }

  function questionBranch(question) {
    const line = String(question.family_line || "");
    if (line.startsWith("Отцовская")) return "paternal";
    if (line.startsWith("Материнская")) return "maternal";
    return "close";
  }

  async function loadQuestionsData() {
    return api("/.netlify/functions/questions");
  }

  async function submitQuestionAnswer(questionId, answerText) {
    return api("/.netlify/functions/question-answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question_id: questionId,
        answer_text: answerText
      })
    });
  }

  async function loadAdminQuestionAnswers() {
    if (viewer?.role !== "admin") return { answers: [] };
    return api("/.netlify/functions/admin-question-answers");
  }

  async function reviewQuestionAnswer(answerId, decision, note="") {
    return api("/.netlify/functions/admin-question-answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        answer_id: answerId,
        decision,
        note
      })
    });
  }

  async function refreshQuestionBadge() {
    const badge = $("#questionBadge");
    if (!badge || !authUser) return;
    try {
      const data = await loadQuestionsData();
      const count = (data.questions || []).filter(q =>
        q.status === "open" && q.channel !== "archive"
      ).length;
      badge.textContent = String(count);
      badge.hidden = count === 0;
    } catch {
      badge.hidden = true;
    }
  }

  function questionAnswerHtml(answer, ownUserId) {
    const own = answer.submitted_by === ownUserId;
    const label = answer.status === "accepted"
      ? "Подтверждённый ответ родственника"
      : answer.status === "pending"
        ? (own ? "Ваш ответ ожидает проверки" : "Ответ ожидает проверки")
        : "Ответ отклонён";
    return `<div class="question-contribution ${answer.status}"><div class="small">${esc(label)} · ${new Date(answer.submitted_at).toLocaleString("ru-RU")}</div><div class="question-answer-text">${esc(answer.answer_text)}</div>${answer.review_note ? `<div class="small">Комментарий: ${esc(answer.review_note)}</div>` : ""}</div>`;
  }

  async function renderQuestionModeration(container, questionsById) {
    if (viewer?.role !== "admin") return;
    const data = await loadAdminQuestionAnswers();
    const pending = (data.answers || []).filter(a => a.status === "pending");
    if (!pending.length) return;

    const html = `<section class="question-moderation card"><div class="page-head compact"><div><div class="eyebrow">Новые ответы</div><h2>Нужно проверить</h2></div><span class="meta-chip">${pending.length}</span></div><div class="moderation-list">${pending.map(a => {
      const q = questionsById.get(a.question_id);
      const who = a.submitter?.display_name || "Родственник";
      return `<article class="moderation-item" data-moderation="${a.id}"><div><div class="small">${esc(a.question_id)} · ${esc(who)} · ${new Date(a.submitted_at).toLocaleString("ru-RU")}</div><b>${esc(q?.question || a.question_id)}</b><p>${esc(a.answer_text)}</p></div><div class="moderation-actions"><textarea rows="2" data-review-note="${a.id}" placeholder="Комментарий (необязательно)"></textarea><div class="access-action-row"><button class="btn primary" data-accept-answer="${a.id}">Принять</button><button class="btn danger" data-reject-answer="${a.id}">Отклонить</button></div></div></article>`;
    }).join("")}</div></section>`;

    container.insertAdjacentHTML("afterbegin", html);

    $$("[data-accept-answer]", container).forEach(btn => btn.onclick = async () => {
      const id = btn.dataset.acceptAnswer;
      const note = $("[data-review-note=\"" + id + "\"]", container)?.value || "";
      btn.disabled = true;
      try {
        await reviewQuestionAnswer(id, "accepted", note);
        toast("Ответ принят");
        await refreshQuestionBadge();
        await renderQuestions($("#app"));
      } catch (e) {
        toast(e.message);
        btn.disabled = false;
      }
    });

    $$("[data-reject-answer]", container).forEach(btn => btn.onclick = async () => {
      const id = btn.dataset.rejectAnswer;
      const note = $("[data-review-note=\"" + id + "\"]", container)?.value || "";
      btn.disabled = true;
      try {
        await reviewQuestionAnswer(id, "rejected", note);
        toast("Ответ отклонён");
        await renderQuestions($("#app"));
      } catch (e) {
        toast(e.message);
        btn.disabled = false;
      }
    });
  }

  async function renderQuestions(app) {
    const data = await loadQuestionsData();
    const questions = data.questions || [];
    const answers = data.answers || [];
    const viewerId = data.viewer?.id || authUser?.id;
    const questionsById = new Map(questions.map(q => [q.id, q]));

    const answersByQuestion = new Map();
    for (const answer of answers) {
      if (!answersByQuestion.has(answer.question_id)) answersByQuestion.set(answer.question_id, []);
      answersByQuestion.get(answer.question_id).push(answer);
    }

    const familyQuestions = questions.filter(q => q.channel !== "archive");
    const openCount = familyQuestions.filter(q => q.status === "open").length;
    const answeredCount = familyQuestions.filter(q => q.status === "answered").length;

    app.innerHTML = `<section class="page questions-page">
      <div class="page-head"><div><div class="eyebrow">Семейное исследование</div><h1>Вопросы родственникам</h1><p class="muted">Здесь собраны вопросы из нашего журнала исследования. Отвечайте даже если знаете только часть — новые ответы сначала проходят проверку администратора.</p></div><span class="meta-chip">${openCount} открытых</span></div>
      <div id="questionModeration"></div>
      <div class="stats question-stats"><div class="stat"><b>${openCount}</b><span>открыто для семьи</span></div><div class="stat"><b>${answeredCount}</b><span>уже есть ответ</span></div><div class="stat"><b>${questions.filter(q=>q.priority==="Критический" && q.status==="open" && q.channel!=="archive").length}</b><span>критических</span></div><div class="stat"><b>${questions.length}</b><span>всего в базе</span></div></div>
      <div class="question-toolbar card">
        <input id="questionSearch" type="search" placeholder="Поиск по вопросу или человеку…">
        <select id="questionStatus"><option value="open">Открытые</option><option value="answered">С ответом</option><option value="all">Все</option></select>
        <select id="questionBranch"><option value="all">Все ветви</option><option value="paternal">Отцовская</option><option value="maternal">Материнская</option><option value="close">Ближайшая семья</option></select>
        <select id="questionPriority"><option value="all">Любой приоритет</option><option value="Критический">Критический</option><option value="Высокий">Высокий</option><option value="Средний">Средний</option><option value="Низкий">Низкий</option></select>
        <label class="archive-toggle"><input id="questionArchive" type="checkbox"> архивные задачи</label>
      </div>
      <div id="questionList" class="question-list"></div>
    </section>`;

    const list = $("#questionList", app);

    function drawQuestions() {
      const search = $("#questionSearch", app).value.trim().toLowerCase();
      const status = $("#questionStatus", app).value;
      const branch = $("#questionBranch", app).value;
      const priority = $("#questionPriority", app).value;
      const showArchive = $("#questionArchive", app).checked;

      let filtered = questions.filter(q => {
        if (!showArchive && q.channel === "archive") return false;
        if (status !== "all" && q.status !== status) return false;
        if (branch !== "all" && questionBranch(q) !== branch) return false;
        if (priority !== "all" && q.priority !== priority) return false;
        if (search) {
          const hay = [q.id,q.family_line,q.subject,q.question,q.ask_or_verify,q.why_needed,q.legacy_answer].filter(Boolean).join(" ").toLowerCase();
          if (!hay.includes(search)) return false;
        }
        return true;
      });

      filtered.sort((a,b) =>
        (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1)
        || (questionPriorityWeight[a.priority] ?? 9) - (questionPriorityWeight[b.priority] ?? 9)
        || a.id.localeCompare(b.id)
      );

      list.innerHTML = filtered.length ? filtered.map(q => {
        const qAnswers = answersByQuestion.get(q.id) || [];
        const accepted = qAnswers.filter(a => a.status === "accepted");
        const minePending = qAnswers.filter(a => a.status === "pending" && a.submitted_by === viewerId);
        const legacy = q.legacy_answer ? `<div class="question-known-answer"><div class="small">Уже известно из предыдущего исследования</div><div class="question-answer-text">${esc(q.legacy_answer)}</div></div>` : "";
        const contributionHtml = [...accepted, ...minePending].map(a => questionAnswerHtml(a, viewerId)).join("");
        return `<article class="question-card card ${q.status}" data-question-card="${q.id}">
          <div class="question-card-head"><div class="question-meta"><span class="question-id">${esc(q.id)}</span><span class="priority-pill ${questionPriorityClass(q.priority)}">${esc(q.priority)}</span><span class="chip">${esc(q.family_line)}</span>${q.channel==="mixed" ? '<span class="chip">семья + документы</span>' : q.channel==="archive" ? '<span class="chip">архив</span>' : ""}</div><span class="question-state ${q.status}">${q.status==="answered" ? "Есть ответ" : "Открыт"}</span></div>
          <div class="eyebrow">${esc(q.subject)}</div>
          <h2>${esc(q.question)}</h2>
          ${q.ask_or_verify ? `<div class="question-detail"><b>Кому задать / где проверить:</b> ${esc(q.ask_or_verify)}</div>` : ""}
          ${q.why_needed ? `<div class="question-detail muted"><b>Зачем:</b> ${esc(q.why_needed)}</div>` : ""}
          ${legacy}
          ${contributionHtml}
          <details class="question-answer-form"><summary>${q.status==="answered" ? "Дополнить ответ" : "Я могу ответить"}</summary><div class="question-answer-editor"><textarea rows="4" maxlength="5000" data-question-text="${q.id}" placeholder="Напишите всё, что помните. Можно указать, откуда вы это знаете, у кого есть документ или фотография."></textarea><button class="btn primary" data-question-submit="${q.id}">Отправить ответ</button></div></details>
        </article>`;
      }).join("") : '<div class="empty card">По выбранным фильтрам вопросов нет.</div>';

      $$("[data-question-submit]", list).forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.questionSubmit;
        const textarea = $("[data-question-text=\"" + id + "\"]", list);
        const textValue = textarea.value.trim();
        if (!textValue) {
          toast("Напишите ответ");
          return;
        }
        btn.disabled = true;
        btn.textContent = "Отправка…";
        try {
          await submitQuestionAnswer(id, textValue);
          toast("Ответ отправлен на проверку");
          await renderQuestions(app);
        } catch (e) {
          toast(e.message);
          btn.disabled = false;
          btn.textContent = "Отправить ответ";
        }
      });
    }

    ["questionSearch","questionStatus","questionBranch","questionPriority","questionArchive"].forEach(id => {
      $("#" + id, app).addEventListener(id === "questionSearch" ? "input" : "change", drawQuestions);
    });

    drawQuestions();
    await renderQuestionModeration($("#questionModeration", app), questionsById);
  }

  async function fetchAccessRequests(status="pending") {
    return api(`/.netlify/functions/admin-access-requests?status=${encodeURIComponent(status)}`);
  }

  async function refreshAccessBadge(showToast=false) {
    const nav=$("#accessNav");
    const badge=$("#accessBadge");
    if (!nav || viewer?.role !== "admin") return;
    nav.hidden=false;
    try {
      const data=await fetchAccessRequests("pending");
      const requests=data.requests || [];
      badge.textContent=String(requests.length);
      badge.hidden=requests.length===0;
      if (showToast && requests.length) {
        const who=requests[0].display_name || requests[0].email;
        toast(requests.length===1 ? `Новая заявка на доступ: ${who}` : `Заявок на доступ: ${requests.length}`);
      }
    } catch {}
  }

  async function reviewAccessRequest(requestId, decision, role, note="") {
    return api("/.netlify/functions/admin-access-requests", {
      method:"POST",
      headers:{ "content-type":"application/json" },
      body:JSON.stringify({
        request_id: requestId,
        decision,
        role,
        note
      })
    });
  }

  async function renderAccessRequests(app) {
    const data=await fetchAccessRequests("all");
    const requests=data.requests || [];
    const pending=requests.filter(r=>r.status==="pending");
    app.innerHTML=`<section class="page"><div class="page-head"><div><div class="eyebrow">Администрирование</div><h1>Заявки на доступ</h1><p class="muted">Новые пользователи не видят семейные данные до явного одобрения администратором.</p></div><span class="meta-chip">${pending.length} ожидают</span></div><div class="access-list">${requests.length ? requests.map(r=>`<article class="card access-request ${r.status}"><div class="access-request-main"><div><div class="eyebrow">${esc(r.status==="pending" ? "Ожидает решения" : r.status==="approved" ? "Одобрено" : "Отклонено")}</div><h2>${esc(r.display_name || r.email)}</h2><div class="small">${esc(r.email)} · ${new Date(r.requested_at).toLocaleString("ru-RU")}</div>${r.message ? `<p>${esc(r.message)}</p>` : '<p class="muted">Комментарий не оставлен.</p>'}</div>${r.status==="pending" ? `<div class="access-actions"><label>Роль<select data-role="${r.id}"><option value="reader">Reader — только чтение</option><option value="editor">Editor — чтение и редактирование</option><option value="admin">Admin — полный доступ</option></select></label><textarea data-note="${r.id}" rows="2" placeholder="Комментарий админа (необязательно)"></textarea><div class="access-action-row"><button class="btn primary" data-approve="${r.id}">Одобрить</button><button class="btn danger" data-reject="${r.id}">Отклонить</button></div></div>` : `<div class="access-result"><b>${r.status==="approved" ? `Роль: ${esc(r.assigned_role || "reader")}` : "Доступ не выдан"}</b>${r.review_note ? `<div class="small">${esc(r.review_note)}</div>` : ""}</div>`}</div></article>`).join("") : '<div class="empty">Заявок пока нет.</div>'}</div></section>`;

    $$("[data-approve]",app).forEach(btn=>btn.onclick=async()=>{
      const id=btn.dataset.approve;
      const role=$(`[data-role="${id}"]`,app).value;
      const note=$(`[data-note="${id}"]`,app).value;
      btn.disabled=true;
      try {
        await reviewAccessRequest(id,"approved",role,note);
        toast("Доступ выдан");
        await refreshAccessBadge();
        await renderAccessRequests(app);
      } catch(e) {
        toast(e.message);
        btn.disabled=false;
      }
    });

    $$("[data-reject]",app).forEach(btn=>btn.onclick=async()=>{
      const id=btn.dataset.reject;
      const note=$(`[data-note="${id}"]`,app).value;
      btn.disabled=true;
      try {
        await reviewAccessRequest(id,"rejected","reader",note);
        toast("Заявка отклонена");
        await refreshAccessBadge();
        await renderAccessRequests(app);
      } catch(e) {
        toast(e.message);
        btn.disabled=false;
      }
    });
  }

  function renderAbout(app) {
    app.innerHTML = `<section class="page"><div class="eyebrow">Архитектура</div><h1>Supabase + Netlify</h1><div class="grid"><article class="card span-6"><h2>Данные</h2><p>Люди, связи, события, источники, гипотезы и медиа хранятся в Supabase. Доступ регулируется Row Level Security.</p></article><article class="card span-6"><h2>Сайт</h2><p>Netlify отдаёт статический интерфейс и серверные функции. Функции обращаются к Supabase с publishable key, поэтому RLS остаётся главным уровнем защиты.</p></article></div></section>`;
  }

  function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2600);}
  $('#mobileNav').onclick=()=>$('.nav').classList.toggle('open');
  document.addEventListener('click',e=>{if(!e.target.closest('.topbar'))$('.nav').classList.remove('open')});
  async function enterAuthenticatedApp() {
    setLoggedInUi(true);
    try {
      await loadTree();
    } catch (error) {
      if (error.status === 403) {
        renderAccessPending();
        return;
      }
      if (error.status === 401) {
        await signOut();
        return;
      }
      throw error;
    }

    if (!hashListenerInstalled) {
      addEventListener("hashchange", route);
      hashListenerInstalled = true;
    }
    if (!location.hash || location.hash === "#/login") location.hash = "#/tree";
    await Promise.all([refreshAccessBadge(true), refreshQuestionBadge()]);
    await route();
  }

  $("#logoutBtn").onclick = signOut;

  (async () => {
    try {
      await loadAuthConfig();
      authSession = readStoredSession();
      authUser = await validateSession();
      if (!authUser) {
        renderLogin();
        return;
      }
      await enterAuthenticatedApp();
    } catch (error) {
      renderLogin(error.message || "Ошибка авторизации");
    }
  })();
})();
