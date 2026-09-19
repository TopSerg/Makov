(() => {
  const $ = (s, el=document) => el.querySelector(s);
  const $$ = (s, el=document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
  let people = [], relationships = [], peopleMap = new Map(), connectionConfidence = new Map();
  let authConfig = null, authSession = null, authUser = null, viewer = null;
  let hashListenerInstalled = false;
  const SESSION_KEY = "makov-family-session";

  const fullName = p => [p.last_name, p.first_name, p.middle_name].filter(Boolean).join(' ');

  function buildConnectionConfidence() {
    const edgeRank = confidence => confidence === 'confirmed' ? 2 : confidence === 'probable' ? 1 : 0;
    const graph = new Map(people.map(p => [p.id, []]));

    for (const r of relationships) {
      if (!graph.has(r.person_a_id) || !graph.has(r.person_b_id)) continue;
      const rank = edgeRank(r.confidence);
      graph.get(r.person_a_id).push([r.person_b_id, rank]);
      graph.get(r.person_b_id).push([r.person_a_id, rank]);
    }

    const score = new Map();
    const queue = [];
    for (const p of people) {
      if (p.generation === 0) {
        score.set(p.id, 2);
        queue.push(p.id);
      }
    }

    while (queue.length) {
      const id = queue.shift();
      const current = score.get(id) ?? 0;
      for (const [next, edge] of graph.get(id) || []) {
        const candidate = Math.min(current, edge);
        if (candidate > (score.get(next) ?? -1)) {
          score.set(next, candidate);
          queue.push(next);
        }
      }
    }
    return score;
  }

  function statusClass(p) {
    if (p.confidence === 'unconfirmed') return 'unconfirmed';
    const link = connectionConfidence.get(p.id);
    if (link === undefined || link === 0) return 'unconfirmed';
    if (p.confidence === 'probable' || link === 1 || p.information_level === 'minimal') return 'limited';
    return 'confirmed';
  }

  function statusText(p) {
    if (p.confidence === 'unconfirmed') return 'Личность не подтверждена';
    const link = connectionConfidence.get(p.id);
    if (link === undefined) return 'Не привязан к древу';
    if (link === 0) return 'Связь с древом не подтверждена';
    if (p.confidence === 'probable' || link === 1) return 'Связь вероятна';
    if (p.information_level === 'minimal') return 'Мало информации';
    return 'Подтверждён';
  }

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
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch("/.netlify/functions/auth-config", { cache: "no-store" });
        if (!r.ok) {
          throw new Error(`HTTP ${r.status}`);
        }

        const config = await r.json();
        if (!config?.url || !config?.publishableKey) {
          throw new Error("неполная конфигурация");
        }

        authConfig = config;
        return authConfig;
      } catch (error) {
        lastError = error;
        authConfig = null;
        if (attempt === 0) {
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }
    }

    throw new Error(`Не удалось загрузить конфигурацию авторизации: ${lastError?.message || "неизвестная ошибка"}`);
  }

  async function authRest(path, options={}) {
    if (!authConfig?.url || !authConfig?.publishableKey) {
      await loadAuthConfig();
    }

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
    connectionConfidence = new Map();
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
      app.innerHTML = `<section class="auth-shell"><div class="auth-card"><div class="auth-lock">✓</div><div class="eyebrow">Заявка отправлена</div><h1>Ждём подтверждения</h1><p>Аккаунт создан, а администратор получил заявку на доступ. После одобрения можно будет сразу войти через обычную форму — подтверждение email не требуется.</p><button class="btn primary" id="backToLogin" type="button">К входу</button></div></section>`;
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


  async function supabaseRequest(path, options={}, retry=true) {
    if (!authConfig?.url || !authConfig?.publishableKey) await loadAuthConfig();
    const token = await ensureAccessToken();
    if (!token) throw new Error("Сессия истекла");
    const headers = { apikey: authConfig.publishableKey, Authorization: `Bearer ${token}`, ...(options.headers || {}) };
    let r = await fetch(`${authConfig.url}${path}`, { ...options, headers });
    if (r.status === 401 && retry && await refreshSession()) return supabaseRequest(path, options, false);
    if (!r.ok) {
      let message = `HTTP ${r.status}`;
      try { const data = await r.json(); message = data.message || data.error || data.msg || message; } catch {}
      throw new Error(message);
    }
    return r;
  }

  async function supabaseJson(path, options={}) {
    const r = await supabaseRequest(path, options);
    if (r.status === 204) return null;
    return r.json();
  }

  function storageObjectPath(path) { return path.split('/').map(encodeURIComponent).join('/'); }
  function safeUploadName(name) { return String(name || 'file').replace(/[\\/]+/g,'_').replace(/[\u0000-\u001f\u007f]+/g,'').trim().slice(0,180) || 'file'; }
  function fileSizeText(bytes) {
    const n = Number(bytes || 0);
    if (n < 1024) return `${n} Б`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
    return `${(n / 1024 / 1024).toFixed(1)} МБ`;
  }

  async function loadTree() {
    const data = await api('/.netlify/functions/tree');
    people = data.people || [];
    relationships = data.relationships || [];
    viewer = data.viewer || null;
    peopleMap = new Map(people.map(p => [p.id, p]));
    connectionConfidence = buildConnectionConfidence();
    const accessNav = $("#accessNav");
    const answersNav = $("#answersNav");
    const questionsNav = $("#questionsNav");
    const aboutNav = $("#aboutNav");
    if (accessNav) accessNav.hidden = viewer?.role !== "admin";
    if (answersNav) answersNav.hidden = viewer?.role !== "admin";
    if (questionsNav) questionsNav.hidden = viewer?.role === "reader";
    if (aboutNav) aboutNav.hidden = viewer?.role === "reader";
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
      else if (page === 'contribute') await renderContribute(app);
      else if (page === 'questions') {
        if (viewer?.role === "reader") location.hash = '#/tree';
        else await renderQuestions(app);
      }
      else if (page === 'answers') {
        if (viewer?.role !== "admin") location.hash = '#/tree';
        else await renderAnswerInbox(app);
      }
      else if (page === 'about') {
        if (viewer?.role === "reader") location.hash = '#/tree';
        else renderAbout(app);
      }
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
    const m = String(p.birth_display || '').match(/(18|19|20)\d{2}/);
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
    const readerMode = viewer?.role === "reader";
    const researchControls = readerMode ? "" : `<label class="btn"><input type="checkbox" id="showCandidates" checked> кандидаты</label><div class="legend"><span><i class="dot confirmed"></i>подтверждено</span><span><i class="dot limited"></i>вероятно / мало сведений</span><span><i class="dot unconfirmed"></i>связь не подтверждена</span></div>`;
    app.innerHTML = `<section class="hero"><div><div class="eyebrow">Семейный архив</div><h1>Семейное древо</h1><p>${readerMode ? "Родственные связи и основные сведения о членах семьи." : "Каждая строка — одно поколение. Ширина каждой ветви теперь рассчитывается по её реальному поддереву: большие семьи получают больше места, супруги остаются рядом, а дети одной семьи подключаются через общую линию."}</p></div><div class="meta-chip">${people.length} записей</div></section>
      <section class="tree-shell"><div class="tree-toolbar"><input id="treeSearch" placeholder="Найти родственника…" autocomplete="off"><button class="btn" id="fitTree">Показать всё</button>${researchControls}</div><div id="treeViewport"><svg class="tree-svg" aria-label="Генеалогическое древо"><g id="scene"></g></svg><div class="tree-hint">колесо — масштаб · перетаскивание — перемещение</div></div></section>`;

    const svg=$('.tree-svg'), scene=$('#scene'), vp=$('#treeViewport');
    const W=230, H=82, YS=190, PERSON_GAP=18, UNIT_GAP=74, BRANCH_GAP=210, BRANCH_PAD=90, CANDIDATE_GAP=300, MIN_SCALE=.08;
    const allGenerations=people.map(generationOf);
    const maxGen=Math.max(0,...allGenerations);
    let scale=.8, tx=vp.clientWidth/2, ty=90, dragging=false, last={x:0,y:0};

    const spouseEdges=relationships.filter(r=>r.relationship_type==='spouse_of');

    function visiblePeople(){
      if (readerMode) return people;
      const toggle = $('#showCandidates');
      return people.filter(p => !toggle || toggle.checked || statusClass(p)!=='unconfirmed');
    }

    function unitWidth(unit){
      return unit.members.length*W + Math.max(0,unit.members.length-1)*PERSON_GAP;
    }

    function orderOfUnit(unit){
      const values=unit.members.map(p=>p.layout_order).filter(Number.isFinite);
      return values.length ? Math.min(...values) : null;
    }

    function manualLayoutX(person){
      // Supabase returns an unset numeric column as null. Number(null) is 0,
      // so converting first used to pin every newly added person to the tree
      // centre instead of letting the branch planner position them.
      if(person.layout_x===null || person.layout_x===undefined || person.layout_x==='') return null;
      const value=Number(person.layout_x);
      return Number.isFinite(value)?value:null;
    }

    function compareUnits(a,b){
      const ao=orderOfUnit(a), bo=orderOfUnit(b);
      if(ao!==null || bo!==null){
        if(ao===null) return 1;
        if(bo===null) return -1;
        if(ao!==bo) return ao-bo;
      }
      return fullName(a.members[0]).localeCompare(fullName(b.members[0]),'ru');
    }

    function coupleComponents(arr){
      const ids=new Set(arr.map(p=>p.id));
      const parent=new Map(arr.map(p=>[p.id,p.id]));
      const find=x=>{
        let r=x;
        while(parent.get(r)!==r) r=parent.get(r);
        while(parent.get(x)!==x){const n=parent.get(x);parent.set(x,r);x=n;}
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

    function unitPath(unit,g){
      const paths=[...new Set(unit.map(p=>p.lineage_path || ''))];
      if(paths.length===1) return paths[0];
      if(g===1 && paths.includes('P') && paths.includes('M')) return '';
      let prefix=paths[0] || '';
      for(const path of paths.slice(1)){
        let i=0;
        while(i<prefix.length && i<path.length && prefix[i]===path[i]) i++;
        prefix=prefix.slice(0,i);
      }
      return prefix;
    }

    function unitsForLayout(){
      const byGeneration=new Map();
      for(const p of visiblePeople()){
        const g=generationOf(p);
        if(!byGeneration.has(g)) byGeneration.set(g,[]);
        byGeneration.get(g).push(p);
      }

      const units=[];
      let unitIndex=0;
      for(const [g,arr] of byGeneration){
        for(const members of coupleComponents(arr)){
          members.sort((a,b)=>{
            const ao=Number.isFinite(a.layout_order)?a.layout_order:null;
            const bo=Number.isFinite(b.layout_order)?b.layout_order:null;
            if(ao!==null || bo!==null){
              if(ao===null) return 1;
              if(bo===null) return -1;
              if(ao!==bo) return ao-bo;
            }
            const sexRank=x=>x.sex==='male'?0:x.sex==='female'?1:2;
            return sexRank(a)-sexRank(b) || fullName(a).localeCompare(fullName(b),'ru');
          });

          const connected=members.some(p=>connectionConfidence.has(p.id));
          units.push({
            id:`u${unitIndex++}`,
            generation:g,
            path:unitPath(members,g),
            members,
            candidate:!connected
          });
        }
      }
      return units;
    }

    function makeBranchNode(prefix=''){
      return {prefix,children:new Map(),exactByGeneration:new Map(),width:0,center:0};
    }

    function buildBranchPlan(units){
      const root=makeBranchNode('');
      const candidates=[];

      for(const unit of units){
        if(unit.candidate){
          candidates.push(unit);
          continue;
        }
        let node=root;
        for(const ch of unit.path){
          if(!node.children.has(ch)) node.children.set(ch,makeBranchNode(node.prefix+ch));
          node=node.children.get(ch);
        }
        if(!node.exactByGeneration.has(unit.generation)) node.exactByGeneration.set(unit.generation,[]);
        node.exactByGeneration.get(unit.generation).push(unit);
      }

      function computeWidth(node){
        let directMax=0;
        for(const rowUnits of node.exactByGeneration.values()){
          rowUnits.sort(compareUnits);
          const w=rowUnits.reduce((sum,u)=>sum+unitWidth(u),0)+Math.max(0,rowUnits.length-1)*UNIT_GAP;
          directMax=Math.max(directMax,w);
        }

        const childList=['P','M'].map(k=>node.children.get(k)).filter(Boolean);
        let childTotal=0;
        for(const child of childList) childTotal+=computeWidth(child);
        if(childList.length>1) childTotal+=BRANCH_GAP*(childList.length-1);

        node.width=Math.max(W+BRANCH_PAD,directMax+BRANCH_PAD,childTotal);
        return node.width;
      }

      const boundaries=[];
      function assign(node,center){
        node.center=center;
        const childList=['P','M'].map(k=>node.children.get(k)).filter(Boolean);
        if(childList.length===1){
          assign(childList[0],center);
        }else if(childList.length>1){
          const total=childList.reduce((s,ch)=>s+ch.width,0)+BRANCH_GAP*(childList.length-1);
          let cursor=center-total/2;
          childList.forEach((child,i)=>{
            const childCenter=cursor+child.width/2;
            assign(child,childCenter);
            cursor+=child.width;
            if(i<childList.length-1){
              boundaries.push({
                prefix:node.prefix,
                x:cursor+BRANCH_GAP/2,
                depth:node.prefix.length
              });
              cursor+=BRANCH_GAP;
            }
          });
        }
      }

      computeWidth(root);
      assign(root,0);
      return {root,candidates,boundaries};
    }

    function layout(){
      const units=unitsForLayout();
      const plan=buildBranchPlan(units);
      const pos=new Map();
      const unitCenters=new Map();

      function placeNode(node){
        for(const [g,rowUnits] of node.exactByGeneration){
          rowUnits.sort(compareUnits);
          const widths=rowUnits.map(unitWidth);
          const total=widths.reduce((s,x)=>s+x,0)+Math.max(0,rowUnits.length-1)*UNIT_GAP;
          let cursor=node.center-total/2;
          rowUnits.forEach((unit,ui)=>{
            const width=widths[ui];
            const unitCenter=cursor+width/2;
            unitCenters.set(unit.id,unitCenter);
            unit.members.forEach((p,mi)=>{
              pos.set(p.id,{
                x:cursor+mi*(W+PERSON_GAP)+W/2,
                y:(maxGen-g)*YS,
                generation:g,
                path:node.prefix,
                unitId:unit.id
              });
            });
            cursor+=width+UNIT_GAP;
          });
        }
        for(const child of node.children.values()) placeNode(child);
      }
      placeNode(plan.root);

      // People that are not connected to the focal family tree are kept in a
      // separate lane instead of being injected into the middle of the tree.
      const candidateByGeneration=new Map();
      for(const unit of plan.candidates){
        if(!candidateByGeneration.has(unit.generation)) candidateByGeneration.set(unit.generation,[]);
        candidateByGeneration.get(unit.generation).push(unit);
      }
      const candidateStart=plan.root.width/2+CANDIDATE_GAP;
      let candidateMaxX=candidateStart;
      for(const [g,rowUnits] of candidateByGeneration){
        rowUnits.sort(compareUnits);
        let cursor=candidateStart;
        rowUnits.forEach(unit=>{
          const width=unitWidth(unit);
          unitCenters.set(unit.id,cursor+width/2);
          unit.members.forEach((p,mi)=>{
            pos.set(p.id,{
              x:cursor+mi*(W+PERSON_GAP)+W/2,
              y:(maxGen-g)*YS,
              generation:g,
              path:'candidate',
              unitId:unit.id
            });
          });
          cursor+=width+UNIT_GAP;
        });
        candidateMaxX=Math.max(candidateMaxX,cursor);
      }

      // TESTED_LAYOUT_X: current family geometry was collision-checked locally.
      // layout_x is an optional manual/tested override; people added later can
      // still fall back to the dynamic branch planner above.
      for (const person of visiblePeople()) {
        const fixedX = manualLayoutX(person);
        if (fixedX === null) continue;
        const current = pos.get(person.id) || {};
        const g = generationOf(person);
        pos.set(person.id, {
          ...current,
          x: fixedX,
          y: (maxGen - g) * YS,
          generation: g,
          path: person.lineage_path || current.path || '',
          unitId: current.unitId || null
        });
      }

      return {pos,plan,unitCenters,candidateStart,candidateMaxX};
    }

    function apply(){
      scene.setAttribute('transform',`translate(${tx} ${ty}) scale(${scale})`);
    }

    function trunc(s,n){
      s=String(s||'');
      return esc(s.length>n?s.slice(0,n-1)+'…':s);
    }

    function branchNode(root,prefix){
      let node=root;
      for(const ch of prefix){
        node=node.children.get(ch);
        if(!node) return null;
      }
      return node;
    }

    function dividerHtml(plan,minY){
      return plan.boundaries.map(b=>{
        const coupleGeneration=b.depth+1;
        const yEnd=(maxGen-coupleGeneration)*YS-H/2-22;
        if(yEnd<=minY+25) return '';
        const cls=b.prefix===''?'branch-divider main':'branch-divider secondary';
        return `<line class="${cls}" x1="${b.x}" y1="${minY}" x2="${b.x}" y2="${yEnd}"/>`;
      }).join('');
    }

    function relationshipClass(rels){
      if(rels.some(r=>r.confidence==='unconfirmed')) return 'unconfirmed';
      if(rels.some(r=>r.confidence==='probable')) return 'probable';
      return '';
    }

    function parentBusHtml(pos,ids){
      const childParents=new Map();

      for(const r of relationships){
        if(r.relationship_type!=='parent_of') continue;
        if(!ids.has(r.person_a_id) || !ids.has(r.person_b_id)) continue;
        if(!childParents.has(r.person_b_id)) childParents.set(r.person_b_id,[]);
        childParents.get(r.person_b_id).push(r);
      }

      const groups=new Map();
      for(const [childId,rels] of childParents){
        const parentIds=[...new Set(rels.map(r=>r.person_a_id))].sort();
        const child=pos.get(childId);
        if(!child || !parentIds.length) continue;
        const style=relationshipClass(rels);
        const key=`${parentIds.join('|')}|${child.generation}|${style}`;
        if(!groups.has(key)) groups.set(key,{parentIds,children:[],rels:[],style});
        groups.get(key).children.push(childId);
        groups.get(key).rels.push(...rels);
      }

      const html=[];
      for(const group of groups.values()){
        const parents=group.parentIds.map(id=>pos.get(id)).filter(Boolean);
        const children=group.children.map(id=>pos.get(id)).filter(Boolean).sort((a,b)=>a.x-b.x);
        if(!parents.length || !children.length) continue;

        const parentBottom=Math.max(...parents.map(p=>p.y+H/2));
        const childTop=Math.min(...children.map(p=>p.y-H/2));

        // Safety fallback for malformed/cross-generation links.
        if(childTop<=parentBottom+16){
          for(const childId of group.children){
            const child=pos.get(childId);
            for(const parentId of group.parentIds){
              const parent=pos.get(parentId);
              if(!parent || !child) continue;
              const mid=(parent.y+child.y)/2;
              html.push(`<path class="edge family ${group.style}" d="M ${parent.x} ${parent.y+H/2} C ${parent.x} ${mid}, ${child.x} ${mid}, ${child.x} ${child.y-H/2}"/>`);
            }
          }
          continue;
        }

        const sourceX=parents.reduce((s,p)=>s+p.x,0)/parents.length;
        const joinY=parentBottom+Math.min(34,(childTop-parentBottom)*.26);
        const busY=parentBottom+(childTop-parentBottom)*.58;

        if(parents.length>1){
          for(const parent of parents){
            html.push(`<path class="edge family ${group.style}" d="M ${parent.x} ${parent.y+H/2} L ${parent.x} ${joinY} L ${sourceX} ${joinY}"/>`);
          }
        }else{
          html.push(`<path class="edge family ${group.style}" d="M ${sourceX} ${parentBottom} L ${sourceX} ${busY}"/>`);
        }

        if(parents.length>1){
          html.push(`<path class="edge family ${group.style}" d="M ${sourceX} ${joinY} L ${sourceX} ${busY}"/>`);
        }

        if(children.length===1){
          const child=children[0];
          html.push(`<path class="edge family ${group.style}" d="M ${sourceX} ${busY} L ${child.x} ${busY} L ${child.x} ${child.y-H/2}"/>`);
        }else{
          const minChildX=Math.min(sourceX,...children.map(ch=>ch.x));
          const maxChildX=Math.max(sourceX,...children.map(ch=>ch.x));
          html.push(`<path class="edge family ${group.style}" d="M ${minChildX} ${busY} L ${maxChildX} ${busY}"/>`);
          for(const child of children){
            html.push(`<path class="edge family ${group.style}" d="M ${child.x} ${busY} L ${child.x} ${child.y-H/2}"/>`);
          }
        }
      }
      return html.join('');
    }

    function draw(focus=''){
      const data=layout();
      const {pos,plan,candidateStart,candidateMaxX}=data;
      const ids=new Set([...pos.keys()]);
      if(!pos.size){scene.innerHTML='';return;}

      const ps=[...pos.values()];
      const minX=Math.min(...ps.map(p=>p.x-W/2))-360;
      const maxX=Math.max(...ps.map(p=>p.x+W/2))+260;
      const minY=Math.min(...ps.map(p=>p.y-H/2))-112;
      const maxY=Math.max(...ps.map(p=>p.y+H/2))+88;

      const generations=[...new Set(ps.map(p=>p.generation))].sort((a,b)=>b-a);
      const rows=generations.map(g=>{
        const y=(maxGen-g)*YS;
        return `<g class="generation-guide"><line x1="${minX}" y1="${y+H/2+45}" x2="${maxX}" y2="${y+H/2+45}"/><text x="${minX+8}" y="${y-H/2-18}">${esc(generationTitle(g))}</text></g>`;
      }).join('');

      const pNode=branchNode(plan.root,'P');
      const mNode=branchNode(plan.root,'M');
      const hasCandidates=plan.candidates.length>0;
      const branchGuides=`<g class="branch-guides">
        ${dividerHtml(plan,minY)}
        ${pNode?`<text class="branch-title paternal" x="${pNode.center}" y="${minY+24}">ОТЦОВСКАЯ ВЕТВЬ</text>`:''}
        ${mNode?`<text class="branch-title maternal" x="${mNode.center}" y="${minY+24}">МАТЕРИНСКАЯ ВЕТВЬ</text>`:''}
        ${hasCandidates?`<line class="branch-divider candidate" x1="${candidateStart-CANDIDATE_GAP/2}" y1="${minY}" x2="${candidateStart-CANDIDATE_GAP/2}" y2="${maxY}"/><text class="branch-title candidate-title" x="${(candidateStart+candidateMaxX)/2}" y="${minY+24}">НЕПРИВЯЗАННЫЕ КАНДИДАТЫ</text>`:''}
      </g>`;

      const spouseHtml=relationships.filter(r=>
        r.relationship_type==='spouse_of' && ids.has(r.person_a_id) && ids.has(r.person_b_id)
      ).map(r=>{
        const a=pos.get(r.person_a_id), b=pos.get(r.person_b_id);
        if(!a||!b) return '';
        const left=a.x<=b.x?a:b, right=a.x<=b.x?b:a;
        const cls=r.confidence==='unconfirmed'?'unconfirmed':r.confidence==='probable'?'probable':'';
        return `<path class="edge spouse ${cls}" d="M ${left.x+W/2} ${left.y} L ${right.x-W/2} ${right.y}"/>`;
      }).join('');

      const familyHtml=parentBusHtml(pos,ids);

      const nodeHtml=visiblePeople().map(p=>{
        const q=pos.get(p.id);
        if(!q) return '';
        const st=statusClass(p);
        const branch=p.lineage_path?` · ${p.lineage_path}`:'';
        return `<g class="node ${st} ${p.id===focus?'focused':''}" data-id="${p.id}" transform="translate(${q.x-W/2},${q.y-H/2})"><rect rx="14" width="${W}" height="${H}"/><text class="name" x="14" y="24">${trunc(fullName(p),28)}</text><text class="sub" x="14" y="45">${trunc(years(p)||p.birth_place||'',31)}</text><text class="tag" x="14" y="66">${trunc(statusText(p),28)}</text></g>`;
      }).join('');

      scene.innerHTML=rows+branchGuides+spouseHtml+familyHtml+nodeHtml;
      $$('.node',scene).forEach(n=>n.onclick=()=>location.hash=`#/person/${n.dataset.id}`);
      apply();
    }

    function fit(){
      const {pos}=layout();
      if(!pos.size) return;
      const ps=[...pos.values()];
      const minX=Math.min(...ps.map(p=>p.x-W/2))-410;
      const maxX=Math.max(...ps.map(p=>p.x+W/2))+270;
      const minY=Math.min(...ps.map(p=>p.y-H/2))-125;
      const maxY=Math.max(...ps.map(p=>p.y+H/2))+115;
      const bw=Math.max(1,maxX-minX), bh=Math.max(1,maxY-minY);
      scale=Math.min((vp.clientWidth-70)/bw,(vp.clientHeight-70)/bh,1);
      scale=Math.max(MIN_SCALE,scale);
      tx=vp.clientWidth/2-(minX+maxX)/2*scale;
      ty=vp.clientHeight/2-(minY+maxY)/2*scale;
      apply();
    }

    function center(id){
      const p=peopleMap.get(id);
      if(!p) return;
      const {pos}=layout();
      const q=pos.get(id);
      if(!q) return;
      scale=Math.max(scale,.92);
      tx=vp.clientWidth/2-q.x*scale;
      ty=vp.clientHeight/2-q.y*scale;
      draw(id);
    }

    svg.addEventListener('wheel',e=>{
      e.preventDefault();
      const rect=svg.getBoundingClientRect(), mx=e.clientX-rect.left, my=e.clientY-rect.top, old=scale;
      scale=Math.max(MIN_SCALE,Math.min(2.2,scale*(e.deltaY<0?1.1:.9)));
      tx=mx-(mx-tx)*(scale/old);
      ty=my-(my-ty)*(scale/old);
      apply();
    },{passive:false});

    vp.addEventListener('pointerdown',e=>{
      if(e.target.closest('.node')) return;
      dragging=true;
      last={x:e.clientX,y:e.clientY};
      vp.setPointerCapture(e.pointerId);
      vp.classList.add('dragging');
    });
    vp.addEventListener('pointermove',e=>{
      if(!dragging) return;
      tx+=e.clientX-last.x;
      ty+=e.clientY-last.y;
      last={x:e.clientX,y:e.clientY};
      apply();
    });
    vp.addEventListener('pointerup',()=>{
      dragging=false;
      vp.classList.remove('dragging');
    });

    $('#fitTree').onclick=fit;
    const candidateToggle=$('#showCandidates');
    if(candidateToggle) candidateToggle.onchange=()=>{draw();fit();};
    $('#treeSearch').oninput=e=>{
      const q=e.target.value.trim().toLowerCase();
      if(!q){draw();return;}
      const p=visiblePeople().find(x=>fullName(x).toLowerCase().includes(q));
      if(p) center(p.id);
    };

    draw();
    setTimeout(fit,0);
  }

  async function renderPerson(app, id) {
    let d;
    try {
      d = await api(`/.netlify/functions/person?id=${encodeURIComponent(id)}`);
    } catch (error) {
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

    const readerMode = viewer?.role === "reader";
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
    const headerMeta = readerMode
      ? ""
      : `<div class="chip-row"><span class="chip">Поколение ${generation}</span><span class="chip">Ветвь: ${esc(lineage)}</span></div>`;
    const statusPill = readerMode ? "" : `<span class="status-pill ${statusClass(p)}">${statusText(p)}</span>`;

    const relationHtml = rels.length
      ? rels.map(({r,other})=>`<a class="relation-item" href="#/person/${other.id}"><b>${esc(fullName(other))}</b><div class="small">${esc(relationLabel(r,other))}${readerMode ? "" : ` · ${esc(r.confidence)}`}</div></a>`).join('')
      : '<div class="muted">Связи не внесены.</div>';

    const researchBlocks = readerMode ? "" : `
        <article class="card span-6"><h2>События</h2>${eventHtml||'<div class="muted">События пока не внесены.</div>'}</article>
        <article class="card span-12"><h2>Гипотезы</h2>${claims||'<div class="muted">Нет активных гипотез.</div>'}</article>`;

    const sourceTitle = readerMode ? "Подтверждённые источники" : "Источники";

    app.innerHTML=`<section class="page">
      <a class="backlink" href="#/tree">← Вернуться к древу</a>
      <div class="page-head"><div><div class="eyebrow">Карточка человека</div><h1>${esc(fullName(p))}</h1>${headerMeta}</div>${statusPill}</div>
      <div class="grid">
        <article class="card span-7"><h2>Что известно</h2>${p.biography?`<p>${esc(p.biography)}</p>`:'<p class="muted">Биография пока не заполнена.</p>'}</article>
        <aside class="card span-5"><h2>Карточка</h2><dl class="kv"><dt>Рождение</dt><dd>${esc(p.birth_display||'не установлено')}</dd><dt>Место рождения</dt><dd>${esc(p.birth_place||'не установлено')}</dd><dt>Смерть</dt><dd>${esc(p.death_display||'нет данных')}</dd><dt>Место смерти</dt><dd>${esc(p.death_place||'нет данных')}</dd></dl></aside>
        <article class="card ${readerMode ? "span-12" : "span-6"}"><h2>Семейные связи</h2><div class="relation-list">${relationHtml}</div></article>
        ${researchBlocks}
        <article class="card span-12"><h2>${sourceTitle}</h2><div class="source-list">${srcs.length?srcs.map(s=>`<div class="source-item"><div class="small">${esc(s.source_type||'Источник')}</div>${s.url?`<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`:`<b>${esc(s.title)}</b>`}${s.archive_name?`<div class="small">${esc([s.archive_name,s.fond,s.inventory,s.file_number].filter(Boolean).join(' · '))}</div>`:''}</div>`).join(''):'<div class="muted">Подтверждённые ссылки пока не привязаны.</div>'}</div></article>
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

  function branchSideLabel(side) {
    return side === "paternal" ? "отцовская сторона"
      : side === "maternal" ? "материнская сторона"
      : "смешанная ветвь";
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

  async function refreshQuestionBadge() {
    const nav = $("#questionsNav");
    const badge = $("#questionBadge");
    if (!badge || !authUser) return;
    if (viewer?.role === "reader") {
      if (nav) nav.hidden = true;
      badge.hidden = true;
      return;
    }
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
      ? (answer.accounted_at ? "Ответ принят и учтён в исследовании" : "Подтверждённый ответ родственника")
      : answer.status === "pending"
        ? (own ? "Ваш ответ ожидает проверки" : "Ответ ожидает проверки")
        : "Ответ отклонён";
    return `<div class="question-contribution ${answer.status}"><div class="small">${esc(label)} · ${new Date(answer.submitted_at).toLocaleString("ru-RU")}</div><div class="question-answer-text">${esc(answer.answer_text)}</div>${answer.review_note ? `<div class="small">Комментарий: ${esc(answer.review_note)}</div>` : ""}</div>`;
  }

  async function renderQuestions(app) {
    const data = await loadQuestionsData();
    const branches = (data.branches || []).filter(b => b.status === "active");
    const questions = data.questions || [];
    const answers = data.answers || [];
    const viewerId = data.viewer?.id || authUser?.id;
    const branchMap = new Map(branches.map(b => [b.id, b]));

    const answersByQuestion = new Map();
    for (const answer of answers) {
      if (!answersByQuestion.has(answer.question_id)) answersByQuestion.set(answer.question_id, []);
      answersByQuestion.get(answer.question_id).push(answer);
    }

    const openFamilyCount = questions.filter(q => q.status === "open" && q.channel !== "archive").length;
    const criticalFamilyCount = questions.filter(q => q.status === "open" && q.channel !== "archive" && q.priority === "Критический").length;

    let activeBranch = branches.find(b =>
      questions.some(q => q.branch_id === b.id && q.status === "open" && q.channel !== "archive")
    )?.id || branches[0]?.id || "";

    app.innerHTML = `<section class="page questions-page">
      <div class="page-head"><div><div class="eyebrow">Семейное исследование</div><h1>Вопросы по веткам</h1><p class="muted">Вопросы сгруппированы по конкретным фамильным веткам. Они появляются из уже достигнутого прогресса: известный факт → следующий пробел → конкретный вопрос родственнику или архиву.</p></div><span class="meta-chip">${openFamilyCount} открытых</span></div>
      <div class="stats question-stats"><div class="stat"><b>${openFamilyCount}</b><span>можно продвинуть сейчас</span></div><div class="stat"><b>${criticalFamilyCount}</b><span>критических</span></div><div class="stat"><b>${branches.length}</b><span>активных веток</span></div><div class="stat"><b>${questions.length}</b><span>вопросов в журнале</span></div></div>
      <div id="researchBranches" class="research-branch-grid"></div>
      <div class="question-toolbar card branch-toolbar">
        <input id="questionSearch" type="search" placeholder="Поиск по вопросу, человеку или факту…">
        <select id="questionStatus"><option value="open">Открытые</option><option value="answered">С ответом</option><option value="all">Все статусы</option></select>
        <select id="questionChannel"><option value="family">Может ответить родственник</option><option value="mixed">Семья + документы</option><option value="archive">Архивный поиск</option><option value="all">Все типы</option></select>
        <select id="questionPriority"><option value="all">Любой приоритет</option><option value="Критический">Критический</option><option value="Высокий">Высокий</option><option value="Средний">Средний</option><option value="Низкий">Низкий</option></select>
      </div>
      <div id="branchQuestionHead"></div>
      <div id="questionList" class="question-list"></div>
    </section>`;

    const branchRoot = $("#researchBranches", app);
    const list = $("#questionList", app);
    const head = $("#branchQuestionHead", app);

    function matchingQuestions(branchId) {
      const search = $("#questionSearch", app).value.trim().toLowerCase();
      const status = $("#questionStatus", app).value;
      const channel = $("#questionChannel", app).value;
      const priority = $("#questionPriority", app).value;

      return questions.filter(q => {
        if (q.branch_id !== branchId) return false;
        if (status !== "all" && q.status !== status) return false;
        if (channel !== "all" && q.channel !== channel) return false;
        if (priority !== "all" && q.priority !== priority) return false;
        if (search) {
          const hay = [q.id,q.subject,q.question,q.ask_or_verify,q.why_needed,q.legacy_answer].filter(Boolean).join(" ").toLowerCase();
          if (!hay.includes(search)) return false;
        }
        return true;
      }).sort((a,b) =>
        (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1)
        || (questionPriorityWeight[a.priority] ?? 9) - (questionPriorityWeight[b.priority] ?? 9)
        || a.id.localeCompare(b.id)
      );
    }

    function drawBranches() {
      branchRoot.innerHTML = branches.map(branch => {
        const all = questions.filter(q => q.branch_id === branch.id);
        const open = all.filter(q => q.status === "open" && q.channel !== "archive").length;
        const totalOpen = all.filter(q => q.status === "open").length;
        return `<button class="research-branch-card ${activeBranch===branch.id ? "active" : ""}" data-branch="${esc(branch.id)}" type="button">
          <div class="research-branch-name">${esc(branch.name)}</div>
          <div><b>${open}</b> вопросов родственникам · ${totalOpen} открыто всего</div>
          <div class="small">${esc(branchSideLabel(branch.family_side))}</div>
        </button>`;
      }).join("");

      $$("[data-branch]", branchRoot).forEach(btn => btn.onclick = () => {
        activeBranch = btn.dataset.branch;
        drawBranches();
        drawQuestions();
      });
    }

    function drawQuestions() {
      const branch = branchMap.get(activeBranch);
      const filtered = matchingQuestions(activeBranch);
      head.innerHTML = branch ? `<section class="branch-progress card"><div><div class="eyebrow">${esc(branch.name)}</div><h2>${esc(branch.name)}</h2><p>${esc(branch.progress_summary || "По ветке уже есть исследовательский прогресс.")}</p></div><span class="chip">${esc(branchSideLabel(branch.family_side))}</span></section>` : "";

      list.innerHTML = filtered.length ? filtered.map(q => {
        const qAnswers = answersByQuestion.get(q.id) || [];
        const accepted = qAnswers.filter(a => a.status === "accepted");
        const minePending = qAnswers.filter(a => a.status === "pending" && a.submitted_by === viewerId);
        const legacy = q.legacy_answer ? `<div class="question-known-answer"><div class="small">Уже известно из предыдущего исследования</div><div class="question-answer-text">${esc(q.legacy_answer)}</div></div>` : "";
        const contributionHtml = [...accepted, ...minePending].map(a => questionAnswerHtml(a, viewerId)).join("");
        const channelLabel = q.channel === "family" ? "родственник"
          : q.channel === "mixed" ? "семья + документы"
          : "архив";
        return `<article class="question-card card ${q.status}" data-question-card="${q.id}">
          <div class="question-card-head"><div class="question-meta"><span class="question-id">${esc(q.id)}</span><span class="priority-pill ${questionPriorityClass(q.priority)}">${esc(q.priority)}</span><span class="chip">${esc(channelLabel)}</span></div><span class="question-state ${q.status}">${q.status==="answered" ? "Есть ответ" : "Открыт"}</span></div>
          <div class="eyebrow">${esc(q.subject)}</div>
          <h2>${esc(q.question)}</h2>
          ${q.why_needed ? `<div class="question-progress"><b>Почему вопрос появился:</b> ${esc(q.why_needed)}</div>` : ""}
          ${q.ask_or_verify ? `<div class="question-detail"><b>Кому задать / где проверить:</b> ${esc(q.ask_or_verify)}</div>` : ""}
          ${legacy}
          ${contributionHtml}
          ${q.channel !== "archive" ? `<details class="question-answer-form"><summary>${q.status==="answered" ? "Дополнить ответ" : "Я могу ответить"}</summary><div class="question-answer-editor"><textarea rows="4" maxlength="5000" data-question-text="${q.id}" placeholder="Напишите всё, что помните. Можно указать, откуда это известно и у кого есть документ или фотография."></textarea><button class="btn primary" data-question-submit="${q.id}">Отправить ответ</button></div></details>` : ""}
        </article>`;
      }).join("") : '<div class="empty card">По этой ветке и выбранным фильтрам вопросов нет.</div>';

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
          toast("Ответ сохранён и отправлен на проверку");
          await refreshAnswerBadge();
          await renderQuestions(app);
        } catch (e) {
          toast(e.message);
          btn.disabled = false;
          btn.textContent = "Отправить ответ";
        }
      });
    }

    ["questionSearch","questionStatus","questionChannel","questionPriority"].forEach(id => {
      $("#" + id, app).addEventListener(id === "questionSearch" ? "input" : "change", drawQuestions);
    });

    drawBranches();
    drawQuestions();
  }

  async function loadAnswerInbox(scope="open") {
    if (viewer?.role !== "admin") return { answers: [], counts: {} };
    return api(`/.netlify/functions/admin-answer-inbox?scope=${encodeURIComponent(scope)}`);
  }

  async function answerInboxAction(answerId, action, note="") {
    return api("/.netlify/functions/admin-answer-inbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer_id: answerId, action, note })
    });
  }

  async function refreshAnswerBadge(showToast=false) {
    const nav = $("#answersNav");
    const badge = $("#answerBadge");
    if (!nav || viewer?.role !== "admin") return;
    nav.hidden = false;
    try {
      const data = await loadAnswerInbox("open");
      const count = (data.counts?.pending || 0) + (data.counts?.accepted_unaccounted || 0);
      badge.textContent = String(count);
      badge.hidden = count === 0;
      if (showToast && count) {
        toast(`Ответов требуют внимания: ${count}`);
      }
    } catch {
      badge.hidden = true;
    }
  }

  async function renderAnswerInbox(app) {
    let showAccounted = false;

    async function draw() {
      const data = await loadAnswerInbox(showAccounted ? "all" : "open");
      const answers = data.answers || [];
      const pending = answers.filter(a => a.status === "pending");
      const accepted = answers.filter(a => a.status === "accepted" && !a.accounted_at);
      const accounted = answers.filter(a => a.status === "accepted" && a.accounted_at);

      const itemHtml = (a, mode) => `<article class="card answer-inbox-item ${mode}">
        <div class="answer-inbox-main"><div><div class="small">${esc(a.branch?.name || "Без ветки")} · ${esc(a.question_id)} · ${new Date(a.submitted_at).toLocaleString("ru-RU")}</div><h2>${esc(a.question?.question || a.question_id)}</h2><div class="small">Ответил: ${esc(a.submitter?.display_name || "Родственник")}</div><p class="answer-body">${esc(a.answer_text)}</p></div>
        <div class="answer-inbox-actions">
          ${mode === "pending" ? `<textarea rows="2" data-inbox-note="${a.id}" placeholder="Комментарий к проверке"></textarea><div class="access-action-row"><button class="btn primary" data-inbox-accept="${a.id}">Принять</button><button class="btn danger" data-inbox-reject="${a.id}">Отклонить</button></div>` : ""}
          ${mode === "accepted" ? `<textarea rows="2" data-inbox-note="${a.id}" placeholder="Где/как учтён ответ (необязательно)"></textarea><button class="btn primary" data-inbox-account="${a.id}">Ответ учтён в базе</button>` : ""}
          ${mode === "accounted" ? `<div class="access-result"><b>Учтено ${new Date(a.accounted_at).toLocaleString("ru-RU")}</b>${a.accounted_note ? `<div class="small">${esc(a.accounted_note)}</div>` : ""}</div>` : ""}
        </div></div>
      </article>`;

      app.innerHTML = `<section class="page answers-page">
        <div class="page-head"><div><div class="eyebrow">Служебный журнал</div><h1>Ответы родственников</h1><p class="muted">Здесь ответ проходит два этапа: сначала проверка, затем отметка «учтён», когда информация уже перенесена в древо, источники или исследовательский журнал. Учтённые ответы не удаляются, но скрыты из рабочей очереди.</p></div><span class="meta-chip">${pending.length + accepted.length} требуют внимания</span></div>
        <div class="stats"><div class="stat"><b>${data.counts?.pending || 0}</b><span>на проверке</span></div><div class="stat"><b>${data.counts?.accepted_unaccounted || 0}</b><span>приняты, но не учтены</span></div><div class="stat"><b>${data.counts?.accounted || 0}</b><span>уже учтены</span></div><div class="stat"><b>${data.counts?.rejected || 0}</b><span>отклонены</span></div></div>
        <label class="answer-history-toggle"><input id="showAccountedAnswers" type="checkbox" ${showAccounted ? "checked" : ""}> показать уже учтённые ответы</label>
        <section class="answer-inbox-section"><div class="branch-section-head"><div><h2>Новые ответы</h2><div class="summary">Сначала проверь, что ответ действительно относится к вопросу и заслуживает доверия.</div></div><span class="meta-chip">${pending.length}</span></div><div class="answer-inbox-list">${pending.length ? pending.map(a=>itemHtml(a,"pending")).join("") : '<div class="empty card">Новых ответов нет.</div>'}</div></section>
        <section class="answer-inbox-section"><div class="branch-section-head"><div><h2>Нужно учесть</h2><div class="summary">Ответ уже принят, но ещё не отмечен как внесённый в основную базу.</div></div><span class="meta-chip">${accepted.length}</span></div><div class="answer-inbox-list">${accepted.length ? accepted.map(a=>itemHtml(a,"accepted")).join("") : '<div class="empty card">Все принятые ответы уже обработаны.</div>'}</div></section>
        ${showAccounted ? `<section class="answer-inbox-section"><div class="branch-section-head"><div><h2>История учтённых ответов</h2></div><span class="meta-chip">${accounted.length}</span></div><div class="answer-inbox-list">${accounted.length ? accounted.map(a=>itemHtml(a,"accounted")).join("") : '<div class="empty card">История пока пуста.</div>'}</div></section>` : ""}
      </section>`;

      $("#showAccountedAnswers", app).onchange = async e => {
        showAccounted = e.target.checked;
        await draw();
      };

      $$("[data-inbox-accept]",app).forEach(btn=>btn.onclick=async()=>{
        const id=btn.dataset.inboxAccept;
        const note=$("[data-inbox-note=\"" + id + "\"]",app)?.value || "";
        btn.disabled=true;
        try {
          await answerInboxAction(id,"accept",note);
          toast("Ответ принят");
          await refreshAnswerBadge();
          await draw();
        } catch(e){toast(e.message);btn.disabled=false;}
      });

      $$("[data-inbox-reject]",app).forEach(btn=>btn.onclick=async()=>{
        const id=btn.dataset.inboxReject;
        const note=$("[data-inbox-note=\"" + id + "\"]",app)?.value || "";
        btn.disabled=true;
        try {
          await answerInboxAction(id,"reject",note);
          toast("Ответ отклонён");
          await refreshAnswerBadge();
          await draw();
        } catch(e){toast(e.message);btn.disabled=false;}
      });

      $$("[data-inbox-account]",app).forEach(btn=>btn.onclick=async()=>{
        const id=btn.dataset.inboxAccount;
        const note=$("[data-inbox-note=\"" + id + "\"]",app)?.value || "";
        btn.disabled=true;
        try {
          await answerInboxAction(id,"account",note);
          toast("Ответ отмечен как учтённый");
          await refreshAnswerBadge();
          await draw();
        } catch(e){toast(e.message);btn.disabled=false;}
      });
    }

    await draw();
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

  async function fetchAdminUsers() {
    return api("/.netlify/functions/admin-users");
  }

  async function changeAdminUserRole(userId, role) {
    return api("/.netlify/functions/admin-users", {
      method:"POST",
      headers:{ "content-type":"application/json" },
      body:JSON.stringify({ user_id:userId, role })
    });
  }

  function roleSelectOptions(currentRole) {
    const roles = [
      ["reader", "Reader — только чтение"],
      ["editor", "Editor — чтение и редактирование"],
      ["admin", "Admin — полный доступ"]
    ];
    return roles.map(([value, label]) =>
      `<option value="${value}" ${currentRole===value ? "selected" : ""}>${label}</option>`
    ).join("");
  }

  async function renderAccessRequests(app) {
    const [requestData, userData]=await Promise.all([
      fetchAccessRequests("all"),
      fetchAdminUsers()
    ]);
    const requests=requestData.requests || [];
    const users=userData.users || [];
    const pending=requests.filter(r=>r.status==="pending");

    const userCards = users.length ? users.map(u=>{
      const isSelf = u.id===authUser?.id;
      const subtitle = [
        u.email ? esc(u.email) : "",
        isSelf ? "это вы" : ""
      ].filter(Boolean).join(" · ");
      return `<article class="card access-request approved"><div class="access-request-main"><div><div class="eyebrow">Пользователь</div><h2>${esc(u.display_name || u.email || u.id)}</h2>${subtitle ? `<div class="small">${subtitle}</div>` : ""}<p class="muted">Текущая роль: <b>${esc(u.role)}</b></p></div><div class="access-actions"><label>Роль<select data-user-role="${u.id}" ${isSelf ? "disabled" : ""}>${roleSelectOptions(u.role)}</select></label>${isSelf ? '<div class="small muted">Собственную роль администратора менять нельзя.</div>' : `<div class="access-action-row"><button class="btn primary" data-save-user-role="${u.id}">Сохранить роль</button></div>`}</div></div></article>`;
    }).join("") : '<div class="empty">Пользователей с выданным доступом пока нет.</div>';

    app.innerHTML=`<section class="page"><div class="page-head"><div><div class="eyebrow">Администрирование</div><h1>Доступ и роли</h1><p class="muted">Администратор может выдавать доступ новым пользователям и менять роли уже одобренных аккаунтов.</p></div><span class="meta-chip">${pending.length} ожидают</span></div><div class="page-head"><div><div class="eyebrow">Пользователи</div><h2>Роли пользователей</h2><p class="muted">Reader — просмотр, Editor — просмотр и редактирование, Admin — полный административный доступ.</p></div></div><div class="access-list">${userCards}</div><div class="page-head"><div><div class="eyebrow">История</div><h2>Заявки на доступ</h2></div></div><div class="access-list">${requests.length ? requests.map(r=>`<article class="card access-request ${r.status}"><div class="access-request-main"><div><div class="eyebrow">${esc(r.status==="pending" ? "Ожидает решения" : r.status==="approved" ? "Одобрено" : "Отклонено")}</div><h2>${esc(r.display_name || r.email)}</h2><div class="small">${esc(r.email)} · ${new Date(r.requested_at).toLocaleString("ru-RU")}</div>${r.message ? `<p>${esc(r.message)}</p>` : '<p class="muted">Комментарий не оставлен.</p>'}</div>${r.status==="pending" ? `<div class="access-actions"><label>Роль<select data-role="${r.id}"><option value="reader">Reader — только чтение</option><option value="editor">Editor — чтение и редактирование</option><option value="admin">Admin — полный доступ</option></select></label><textarea data-note="${r.id}" rows="2" placeholder="Комментарий админа (необязательно)"></textarea><div class="access-action-row"><button class="btn primary" data-approve="${r.id}">Одобрить</button><button class="btn danger" data-reject="${r.id}">Отклонить</button></div></div>` : `<div class="access-result"><b>${r.status==="approved" ? `Роль при одобрении: ${esc(r.assigned_role || "reader")}` : "Доступ не выдан"}</b>${r.review_note ? `<div class="small">${esc(r.review_note)}</div>` : ""}</div>`}</div></article>`).join("") : '<div class="empty">Заявок пока нет.</div>'}</div></section>`;

    $$("[data-save-user-role]",app).forEach(btn=>btn.onclick=async()=>{
      const id=btn.dataset.saveUserRole;
      const role=$(`[data-user-role="${id}"]`,app).value;
      btn.disabled=true;
      try {
        await changeAdminUserRole(id,role);
        toast("Роль пользователя обновлена");
        await renderAccessRequests(app);
      } catch(e) {
        toast(e.message);
        btn.disabled=false;
      }
    });

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


  async function renderContribute(app) {
    let branches = [];
    try { branches = await supabaseJson('/rest/v1/research_branches?select=id,name,status,sort_order&status=eq.active&order=sort_order.asc') || []; } catch {}
    const ownFilter = viewer?.role === 'admin' ? '' : `&submitted_by=eq.${encodeURIComponent(authUser?.id || '')}`;
    const select = encodeURIComponent('id,submitted_by,title,body,branch_id,status,review_note,created_at,family_contribution_files(id,original_name,mime_type,size_bytes,object_path)');
    const contributions = await supabaseJson(`/rest/v1/family_contributions?select=${select}${ownFilter}&order=created_at.desc&limit=30`) || [];
    const branchMap = new Map(branches.map(b => [b.id,b.name]));
    const statusLabel = status => ({pending:'Новый материал',reviewed:'Просмотрено',processed:'Учтено',rejected:'Отклонено'}[status] || status);
    const statusClass = status => status === 'processed' ? 'confirmed' : status === 'rejected' ? 'unconfirmed' : 'limited';

    app.innerHTML = `<section class="page contribution-page">
      <div class="page-head"><div><div class="eyebrow">Семейный архив</div><h1>Добавить информацию</h1><p class="muted">Оставьте факт, воспоминание, уточнение или документ. Материал сначала сохраняется как входящая информация.</p></div></div>
      <div class="grid contribution-grid">
        <article class="card span-7"><h2>Новый материал</h2><form id="contributionForm" class="contribution-form">
          <label>Заголовок <span class="small">(необязательно)</span><input id="contributionTitle" maxlength="200" placeholder="Например: документы Цыбенко из семейного архива"></label>
          <label>К какой ветке относится <span class="small">(необязательно)</span><select id="contributionBranch"><option value="">Не знаю / несколько веток</option>${branches.map(b=>`<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}</select></label>
          <label>Текст <span class="small">(можно оставить пустым, если прикладываете файлы)</span><textarea id="contributionBody" rows="9" maxlength="20000" placeholder="Напишите всё, что знаете: кто это сообщил, о каком человеке речь, даты, места, ссылки и пояснения."></textarea></label>
          <label class="file-drop"><span><b>Файлы</b> <span class="small">до 10 файлов, каждый до 25 МБ</span></span><input id="contributionFiles" type="file" multiple><span class="file-drop-hint">Фотографии, PDF, документы, таблицы и другие материалы</span></label>
          <div id="selectedContributionFiles" class="selected-files"></div>
          <div class="contribution-actions"><button class="btn primary" id="contributionSubmit" type="submit">Сохранить материал</button><span class="small">Файлы хранятся в приватном семейном хранилище.</span></div>
        </form></article>
        <aside class="card span-5 contribution-help"><h2>Что сюда можно добавить</h2><ul class="facts"><li>семейное воспоминание;</li><li>фотографию, скан, PDF или архивный документ;</li><li>ссылку и пояснение;</li><li>исправление существующей информации;</li><li>любую зацепку, даже если пока непонятно, куда её привязать.</li></ul><div class="callout"><b>Важно:</b> добавленный материал сначала остаётся входящей информацией. Его можно позже проверить и связать с человеком, источником или фактом.</div></aside>
      </div>
      <div class="page-head contribution-history-title"><div><div class="eyebrow">${viewer?.role === 'admin' ? 'Входящие материалы' : 'История'}</div><h2>${viewer?.role === 'admin' ? 'Последние добавления' : 'Ваши материалы'}</h2></div><span class="meta-chip">${contributions.length}</span></div>
      <div class="contribution-history">${contributions.length ? contributions.map(item=>`<article class="card contribution-history-item"><div class="contribution-history-head"><div><div class="small">${new Date(item.created_at).toLocaleString('ru-RU')}</div><h2>${esc(item.title || 'Материал без заголовка')}</h2></div><span class="status-pill ${statusClass(item.status)}">${esc(statusLabel(item.status))}</span></div>${item.branch_id?`<div class="chip-row"><span class="chip">${esc(branchMap.get(item.branch_id)||item.branch_id)}</span></div>`:''}${item.body?`<p class="contribution-body">${esc(item.body)}</p>`:''}${(item.family_contribution_files||[]).length?`<div class="contribution-files">${item.family_contribution_files.map(f=>`<div class="contribution-file"><span>📎 ${esc(f.original_name)}</span><span class="small">${fileSizeText(f.size_bytes)}</span></div>`).join('')}</div>`:''}${item.review_note?`<div class="small contribution-review-note">Комментарий: ${esc(item.review_note)}</div>`:''}</article>`).join(''):'<div class="empty card">Вы ещё ничего не добавляли.</div>'}</div>
    </section>`;

    const fileInput = $('#contributionFiles',app);
    fileInput.onchange = () => {
      $('#selectedContributionFiles',app).innerHTML = [...fileInput.files].map(f=>`<div class="contribution-file"><span>📎 ${esc(f.name)}</span><span class="small">${fileSizeText(f.size)}</span></div>`).join('');
    };

    $('#contributionForm',app).onsubmit = async e => {
      e.preventDefault();
      const title=$('#contributionTitle',app).value.trim(), body=$('#contributionBody',app).value.trim(), branchId=$('#contributionBranch',app).value||null;
      const files=[...fileInput.files];
      if(!body && !files.length){ toast('Добавьте текст или хотя бы один файл'); return; }
      if(files.length>10){ toast('Можно прикрепить не более 10 файлов за раз'); return; }
      const tooLarge=files.find(f=>f.size>25*1024*1024); if(tooLarge){ toast(`Файл «${tooLarge.name}» больше 25 МБ`); return; }
      const btn=$('#contributionSubmit',app); btn.disabled=true; btn.textContent='Сохранение…';
      try {
        const rows=await supabaseJson('/rest/v1/family_contributions',{method:'POST',headers:{'content-type':'application/json','Prefer':'return=representation'},body:JSON.stringify({submitted_by:authUser.id,title:title||null,body,branch_id:branchId})});
        const contribution=rows?.[0]; if(!contribution?.id) throw new Error('Не удалось создать запись материала');
        for(let i=0;i<files.length;i++){
          btn.textContent=`Загрузка файлов ${i+1}/${files.length}…`;
          const f=files[i], randomPart=crypto.randomUUID(), objectPath=`${authUser.id}/${contribution.id}/${randomPart}-${safeUploadName(f.name)}`;
          await supabaseRequest(`/storage/v1/object/family-contributions/${storageObjectPath(objectPath)}`,{method:'POST',headers:{'content-type':f.type||'application/octet-stream','x-upsert':'false'},body:f});
          await supabaseJson('/rest/v1/family_contribution_files',{method:'POST',headers:{'content-type':'application/json','Prefer':'return=minimal'},body:JSON.stringify({contribution_id:contribution.id,uploaded_by:authUser.id,bucket:'family-contributions',object_path:objectPath,original_name:f.name,mime_type:f.type||null,size_bytes:f.size})});
        }
        toast('Материал сохранён'); await renderContribute(app);
      } catch(error){ toast(error.message||'Не удалось сохранить материал'); btn.disabled=false; btn.textContent='Сохранить материал'; }
    };
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
    await Promise.all([refreshAccessBadge(true), refreshQuestionBadge(), refreshAnswerBadge(true)]);
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
