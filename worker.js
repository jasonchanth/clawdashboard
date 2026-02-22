// Cloudflare Worker - OpenClaw Dashboard with Multi-Host Monitoring
// 部署到 Cloudflare Workers，需要綁定 KV namespace: OPENCLAW_MONITOR

const USERNAME = 'admin';
const PASSWORD = 'admin';
const AGENT_TOKEN = 'vkBUqKitQ8vUwC5-P4ZPiD5SZTG-8AjhDt8jT1kE';  // Agent 認證 Token

async function sha256(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function getAuthCookie(request) {
    const cookie = request.headers.get('Cookie');
    if (!cookie) return null;
    const match = cookie.match(/auth=([^;]+)/);
    return match ? match[1] : null;
}

async function verifyAuth(request) {
    const authCookie = getAuthCookie(request);
    if (!authCookie) return false;
    const expectedHash = await sha256(USERNAME + ':' + PASSWORD);
    return authCookie === expectedHash;
}

async function handleLogin(request) {
    const formData = await request.formData();
    const username = formData.get('username');
    const password = formData.get('password');
    
    if (username === USERNAME && password === PASSWORD) {
        const hash = await sha256(username + ':' + password);
        return new Response('Login successful', {
            status: 302,
            headers: {
                'Location': '/',
                'Set-Cookie': `auth=${hash}; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`,
            },
        });
    }
    
    return new Response(loginHTML('Invalid credentials'), {
        headers: { 'Content-Type': 'text/html' },
        status: 401,
    });
}

// ============ Agent API 處理 ============

async function handleAgentReport(request, env) {
    try {
        const data = await request.json();
        
        // 驗證 Token
        if (data.agent_token !== AGENT_TOKEN) {
            return jsonResponse({ error: 'Invalid token' }, 401);
        }
        
        const hostname = data.system?.hostname || 'unknown';
        const timestamp = new Date().toISOString();
        
        // 保存到 KV
        const hostData = {
            hostname,
            last_seen: timestamp,
            system: data.system,
            openclaw: data.openclaw,
            updated_at: timestamp
        };
        
        await env.OPENCLAW_MONITOR.put(`host:${hostname}`, JSON.stringify(hostData));
        
        // 更新主機列表
        let hosts = await env.OPENCLAW_MONITOR.get('hosts_list');
        hosts = hosts ? JSON.parse(hosts) : [];
        if (!hosts.includes(hostname)) {
            hosts.push(hostname);
            await env.OPENCLAW_MONITOR.put('hosts_list', JSON.stringify(hosts));
        }
        
        return jsonResponse({ status: 'ok' });
        
    } catch (e) {
        return jsonResponse({ error: e.message }, 500);
    }
}

async function getHostsData(env) {
    try {
        const hostsList = await env.OPENCLAW_MONITOR.get('hosts_list');
        if (!hostsList) return [];
        
        const hostnames = JSON.parse(hostsList);
        const hosts = [];
        
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        
        for (const hostname of hostnames) {
            const data = await env.OPENCLAW_MONITOR.get(`host:${hostname}`);
            if (data) {
                const host = JSON.parse(data);
                const lastSeen = new Date(host.last_seen);
                host.is_online = lastSeen > fiveMinutesAgo;
                hosts.push(host);
            }
        }
        
        return hosts;
    } catch (e) {
        return [];
    }
}

async function getStats(env) {
    const hosts = await getHostsData(env);
    const onlineHosts = hosts.filter(h => h.is_online);
    const openclawRunning = hosts.filter(h => h.openclaw?.status === 'running');
    
    return {
        total_hosts: hosts.length,
        online_hosts: onlineHosts.length,
        offline_hosts: hosts.length - onlineHosts.length,
        openclaw_running: openclawRunning.length
    };
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        }
    });
}

// ============ HTML 頁面 ============

function loginHTML(error = '') {
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Login - OpenClaw Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0f0f23;
            color: #e0e0e0;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .login-box {
            background: #1a1a2e;
            padding: 40px;
            border-radius: 12px;
            border: 1px solid #333;
            width: 100%;
            max-width: 400px;
        }
        h1 {
            text-align: center;
            margin-bottom: 30px;
            background: linear-gradient(90deg, #00d4ff, #7b2cbf);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .error {
            background: #451a03;
            color: #fb923c;
            padding: 12px;
            border-radius: 6px;
            margin-bottom: 20px;
            text-align: center;
        }
        input {
            width: 100%;
            padding: 12px;
            margin-bottom: 15px;
            background: #0f0f1a;
            border: 1px solid #333;
            border-radius: 6px;
            color: #fff;
            font-size: 1rem;
        }
        input:focus { outline: none; border-color: #00d4ff; }
        button {
            width: 100%;
            padding: 12px;
            background: #7b2cbf;
            color: white;
            border: none;
            border-radius: 6px;
            font-size: 1rem;
            cursor: pointer;
        }
        button:hover { background: #9333ea; }
    </style>
</head>
<body>
    <div class="login-box">
        <h1>🦞 OpenClaw Dashboard</h1>
        ${error ? `<div class="error">${error}</div>` : ''}
        <form method="POST" action="/login">
            <input type="text" name="username" placeholder="Username" required>
            <input type="password" name="password" placeholder="Password" required>
            <button type="submit">Login</button>
        </form>
    </div>
</body>
</html>`;
}

async function serveDashboard(env) {
    // 讀取 Gist 數據（原有功能）
    const gistUrl = 'https://gist.githubusercontent.com/jasonchanth/1c120e23010c6a25228ca209b204bc92/raw/openclaw-status.json';
    
    let gistData = {};
    try {
        const response = await fetch(gistUrl + '?t=' + Date.now());
        gistData = await response.json();
    } catch (e) {
        gistData = { error: e.message };
    }
    
    // 讀取多主機監控數據
    const hosts = await getHostsData(env);
    const stats = await getStats(env);
    
    return new Response(dashboardHTML(gistData, hosts, stats), {
        headers: { 'Content-Type': 'text/html' },
    });
}

function dashboardHTML(gistData, hosts, stats) {
    const hostsJson = JSON.stringify(hosts).replace(/</g, '\\u003c');
    const statsJson = JSON.stringify(stats).replace(/</g, '\\u003c');
    
    return `<!DOCTYPE html>
<html lang="zh-HK">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OpenClaw Dashboard</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0f0f23;
            color: #e0e0e0;
            min-height: 100vh;
            padding: 20px;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        header {
            text-align: center;
            padding: 30px 0;
            border-bottom: 1px solid #333;
            margin-bottom: 30px;
            position: relative;
        }
        h1 { font-size: 2.5rem; background: linear-gradient(90deg, #00d4ff, #7b2cbf); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .subtitle { color: #888; margin-top: 10px; }
        .logout {
            position: absolute;
            top: 20px;
            right: 20px;
            color: #666;
            text-decoration: none;
            font-size: 0.9rem;
        }
        .logout:hover { color: #fff; }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        .card {
            background: #1a1a2e;
            border-radius: 12px;
            padding: 20px;
            border: 1px solid #333;
        }
        .card.wide { grid-column: 1 / -1; }
        .card h2 {
            font-size: 1rem;
            color: #00d4ff;
            margin-bottom: 15px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .stat-row {
            display: flex;
            justify-content: space-between;
            padding: 10px 0;
            border-bottom: 1px solid #333;
        }
        .stat-row:last-child { border-bottom: none; }
        .stat-label { color: #888; }
        .stat-value { color: #fff; font-weight: 500; }
        .badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 0.75rem;
            font-weight: 600;
        }
        .badge-green { background: #0f3d0f; color: #4ade80; }
        .badge-blue { background: #1e3a5f; color: #60a5fa; }
        .badge-orange { background: #451a03; color: #fb923c; }
        .badge-purple { background: #4c1d95; color: #a78bfa; }
        .badge-pink { background: #831843; color: #f472b6; }
        .badge-cyan { background: #164e63; color: #67e8f9; }
        .badge-red { background: #7f1d1d; color: #fca5a5; }
        .badge-yellow { background: #713f12; color: #fde047; }
        .cron-item, .task-item, .host-item {
            padding: 12px;
            background: #0f0f1a;
            border-radius: 8px;
            margin-bottom: 10px;
        }
        .cron-item:last-child, .task-item:last-child, .host-item:last-child { margin-bottom: 0; }
        .item-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 5px;
        }
        .item-name { font-weight: 500; color: #fff; }
        .item-meta { font-size: 0.85rem; color: #666; margin-top: 4px; }
        .loading { text-align: center; padding: 40px; color: #666; }
        .error { text-align: center; padding: 40px; color: #ef4444; }
        .last-updated {
            text-align: center;
            color: #666;
            font-size: 0.85rem;
            margin-top: 20px;
        }
        .refresh-btn {
            background: #7b2cbf;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 0.9rem;
            margin-top: 10px;
        }
        .refresh-btn:hover { background: #9333ea; }
        .empty-state {
            text-align: center;
            padding: 20px;
            color: #666;
            font-style: italic;
        }
        
        /* 多主機監控樣式 */
        .monitor-section {
            background: linear-gradient(135deg, #1a1a2e 0%, #0f172a 100%);
        }
        .stats-overview {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 15px;
            margin-bottom: 20px;
        }
        .overview-card {
            background: #0f0f1a;
            padding: 15px;
            border-radius: 8px;
            text-align: center;
        }
        .overview-card h3 {
            font-size: 0.8rem;
            color: #888;
            margin-bottom: 8px;
        }
        .overview-card .value {
            font-size: 1.8rem;
            font-weight: 600;
            color: #fff;
        }
        .hosts-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 15px;
        }
        .host-card {
            background: #0f0f1a;
            border-radius: 10px;
            padding: 15px;
            border: 1px solid #333;
            transition: transform 0.2s, border-color 0.2s;
            cursor: pointer;
        }
        .host-card:hover {
            transform: translateY(-2px);
            border-color: #7b2cbf;
        }
        .host-card.offline {
            opacity: 0.6;
        }
        .host-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 12px;
        }
        .host-name {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .host-icon {
            width: 32px;
            height: 32px;
            background: #1a1a2e;
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .host-title {
            font-weight: 600;
            font-size: 0.95rem;
        }
        .host-subtitle {
            font-size: 0.75rem;
            color: #666;
        }
        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #34c759;
            box-shadow: 0 0 8px #34c759;
        }
        .status-dot.offline {
            background: #ff3b30;
            box-shadow: 0 0 8px #ff3b30;
        }
        .host-stats {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
        }
        .host-stat {
            display: flex;
            justify-content: space-between;
            font-size: 0.8rem;
            padding: 6px 0;
            border-bottom: 1px solid #222;
        }
        .host-stat:last-child { border-bottom: none; }
        .progress-bar {
            width: 100%;
            height: 4px;
            background: #222;
            border-radius: 2px;
            overflow: hidden;
            margin-top: 4px;
        }
        .progress-fill {
            height: 100%;
            border-radius: 2px;
            transition: width 0.3s;
        }
        .progress-fill.low { background: #34c759; }
        .progress-fill.medium { background: #ff9500; }
        .progress-fill.high { background: #ff3b30; }
        
        /* 原有樣式 */
        .ideas-section { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); }
        .idea-item {
            background: #0f0f1a;
            padding: 12px;
            border-radius: 8px;
            margin-bottom: 10px;
            border-left: 3px solid #00d4ff;
        }
        .executing-section { background: linear-gradient(135deg, #1a1a2e 0%, #1e1b4b 100%); }
        .executing-item {
            background: #0f0f1a;
            padding: 12px;
            border-radius: 8px;
            margin-bottom: 10px;
            border-left: 3px solid #fbbf24;
            animation: pulse 2s infinite;
        }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
        .agents-section { background: linear-gradient(135deg, #1a1a2e 0%, #1e1b4b 100%); }
        .agent-item {
            background: #0f0f1a;
            padding: 12px;
            border-radius: 8px;
            margin-bottom: 10px;
            border-left: 3px solid #7b2cbf;
        }
        .agent-skills { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
        .skill-tag {
            display: inline-block;
            padding: 3px 8px;
            background: #2d1b4e;
            color: #c084fc;
            border-radius: 4px;
            font-size: 0.75rem;
            font-weight: 500;
        }
        .skills-section { background: linear-gradient(135deg, #1a1a2e 0%, #0f172a 100%); }
        .skill-category { margin-bottom: 15px; }
        .skill-category:last-child { margin-bottom: 0; }
        .category-header {
            font-size: 0.85rem;
            color: #888;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 8px;
        }
        .category-skills { display: flex; flex-wrap: wrap; gap: 6px; }
        .category-skill-tag {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 4px 10px;
            border-radius: 6px;
            font-size: 0.8rem;
            font-weight: 500;
        }
        .category-skill-tag .location { font-size: 0.65rem; opacity: 0.7; }
        .chart-container { position: relative; height: 250px; margin-top: 10px; }
        .token-chart-section { background: linear-gradient(135deg, #1a1a2e 0%, #1e1b4b 100%); }
        
        @media (max-width: 768px) {
            .stats-overview { grid-template-columns: repeat(2, 1fr); }
            .hosts-grid { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <a href="/logout" class="logout">Logout</a>
            <h1>🦞 OpenClaw Dashboard</h1>
            <p class="subtitle">實時狀態監控</p>
        </header>

        <div id="content">
            <div class="loading">載入中...</div>
        </div>

        <div class="last-updated">
            <span id="last-updated-time"></span>
            <br>
            <button class="refresh-btn" onclick="loadData()">🔄 刷新</button>
        </div>
    </div>

    <script>
        const GIST_URL = 'https://gist.githubusercontent.com/jasonchanth/1c120e23010c6a25228ca209b204bc92/raw/openclaw-status.json';
        let tokenChart = null;
        
        // 從服務器注入的數據
        const MONITOR_HOSTS = ${hostsJson};
        const MONITOR_STATS = ${statsJson};

        async function loadData() {
            const content = document.getElementById('content');
            content.innerHTML = '<div class="loading">載入中...</div>';

            try {
                const response = await fetch(GIST_URL + '?t=' + Date.now());
                if (!response.ok) throw new Error('無法載入數據');
                const data = await response.json();
                renderDashboard(data);
            } catch (error) {
                content.innerHTML = '<div class="error">錯誤: ' + error.message + '</div>';
            }
        }

        function renderDashboard(data) {
            const content = document.getElementById('content');
            const updatedTime = new Date(data.updatedAt).toLocaleString('zh-HK');
            document.getElementById('last-updated-time').textContent = '最後更新: ' + updatedTime;

            let html = '<div class="grid">';
            
            // ========== 多主機監控區塊 ==========
            html += '<div class="card wide monitor-section">';
            html += '<h2>🖥️ 多主機監控 (' + MONITOR_STATS.online_hosts + '/' + MONITOR_STATS.total_hosts + ' 在線)</h2>';
            
            // 統計概覽
            html += '<div class="stats-overview">';
            html += '<div class="overview-card"><h3>總設備</h3><div class="value">' + MONITOR_STATS.total_hosts + '</div></div>';
            html += '<div class="overview-card"><h3>在線</h3><div class="value" style="color:#4ade80">' + MONITOR_STATS.online_hosts + '</div></div>';
            html += '<div class="overview-card"><h3>離線</h3><div class="value" style="color:#ef4444">' + MONITOR_STATS.offline_hosts + '</div></div>';
            html += '<div class="overview-card"><h3>OpenClaw</h3><div class="value" style="color:#fbbf24">' + MONITOR_STATS.openclaw_running + '</div></div>';
            html += '</div>';
            
            // 主機列表
            if (MONITOR_HOSTS.length > 0) {
                html += '<div class="hosts-grid">';
                MONITOR_HOSTS.forEach(host => {
                    const sys = host.system || {};
                    const oc = host.openclaw || {};
                    const isOnline = host.is_online;
                    const cpuClass = sys.cpu_percent > 80 ? 'high' : sys.cpu_percent > 50 ? 'medium' : 'low';
                    
                    html += '<div class="host-card ' + (isOnline ? '' : 'offline') + '">';
                    html += '<div class="host-header">';
                    html += '<div class="host-name">';
                    html += '<div class="host-icon">🖥️</div>';
                    html += '<div>';
                    html += '<div class="host-title">' + host.hostname + '</div>';
                    html += '<div class="host-subtitle">' + (sys.platform || 'Unknown') + '</div>';
                    html += '</div>';
                    html += '</div>';
                    html += '<div class="status-dot ' + (isOnline ? '' : 'offline') + '"></div>';
                    html += '</div>';
                    
                    html += '<div class="host-stats">';
                    html += '<div class="host-stat"><span>OpenClaw</span><span style="color:' + (oc.status === 'running' ? '#4ade80' : '#ef4444') + '">' + (oc.status === 'running' ? '✓ 運作中' : '✗ 停止') + '</span></div>';
                    html += '<div class="host-stat"><span>版本</span><span>' + (oc.version || 'unknown') + '</span></div>';
                    html += '<div class="host-stat"><span>CPU</span><span>' + (sys.cpu_percent?.toFixed(1) || '-') + '%</span></div>';
                    html += '<div class="host-stat"><span>記憶體</span><span>' + (sys.memory_percent?.toFixed(1) || '-') + '%</span></div>';
                    html += '</div>';
                    
                    html += '<div class="progress-bar"><div class="progress-fill ' + cpuClass + '" style="width:' + (sys.cpu_percent || 0) + '%"></div></div>';
                    html += '</div>';
                });
                html += '</div>';
            } else {
                html += '<div class="empty-state">暫無監控主機，請在各主機部署 Agent</div>';
            }
            
            html += '</div>';
            
            // 系統狀態
            html += '<div class="card">';
            html += '<h2>⚙️ 系統狀態</h2>';
            html += '<div class="stat-row"><span class="stat-label">版本</span><span class="stat-value">' + (data.version || 'N/A') + '</span></div>';
            html += '<div class="stat-row"><span class="stat-label">當前模型</span><span class="stat-value">' + (data.model || 'N/A') + '</span></div>';
            html += '<div class="stat-row"><span class="stat-label">活躍 Sessions</span><span class="stat-value">' + (typeof data.sessions === 'number' ? data.sessions : (data.sessions?.length || 0)) + '</span></div>';
            html += '<div class="stat-row"><span class="stat-label">Token 使用量</span><span class="stat-value">' + (data.tokens?.total?.toLocaleString() || 'N/A') + '</span></div>';
            html += '</div>';

            // Cron Jobs
            html += '<div class="card">';
            html += '<h2>⏰ Cron Jobs (' + (data.cronJobs?.length || 0) + ')</h2>';
            if (data.cronJobs?.length) {
                data.cronJobs.forEach(job => {
                    html += '<div class="cron-item">';
                    html += '<div class="item-header"><span class="item-name">' + job.name + '</span><span class="badge ' + (job.enabled ? 'badge-green' : 'badge-orange') + '">' + (job.enabled ? '啟用' : '停用') + '</span></div>';
                    html += '<div class="item-meta">' + job.schedule + '</div>';
                    html += '</div>';
                });
            } else {
                html += '<div class="empty-state">無 Cron Jobs</div>';
            }
            html += '</div>';

            // 正在執行
            html += '<div class="card executing-section">';
            html += '<h2>⚡ 正在執行 (' + (data.executingTasks?.length || 0) + ')</h2>';
            if (data.executingTasks?.length) {
                data.executingTasks.forEach(task => {
                    html += '<div class="executing-item">';
                    html += '<div class="item-name">' + (task.name || task) + '</div>';
                    if (task.startTime) {
                        html += '<div class="item-meta">開始: ' + new Date(task.startTime).toLocaleString('zh-HK') + '</div>';
                    }
                    html += '</div>';
                });
            } else {
                html += '<div class="empty-state">目前沒有正在執行的任務</div>';
            }
            html += '</div>';

            // Ideas
            html += '<div class="card ideas-section">';
            html += '<h2>💡 Ideas (' + (data.ideas?.length || 0) + ')</h2>';
            if (data.ideas?.length) {
                data.ideas.forEach(idea => {
                    html += '<div class="idea-item">';
                    html += '<div class="item-name">' + (idea.text || idea) + '</div>';
                    if (idea.createdAt) {
                        html += '<div class="item-meta">' + new Date(idea.createdAt).toLocaleString('zh-HK') + '</div>';
                    }
                    html += '</div>';
                });
            } else {
                html += '<div class="empty-state">暫無 Ideas</div>';
            }
            html += '</div>';

            // 已完成
            html += '<div class="card">';
            html += '<h2>✅ 已完成 (' + (data.completedTasks?.length || 0) + ')</h2>';
            if (data.completedTasks?.length) {
                data.completedTasks.slice(0, 5).forEach(task => {
                    html += '<div class="task-item">';
                    html += '<div class="item-name">' + (task.task || task.name || task) + '</div>';
                    if (task.time) {
                        html += '<div class="item-meta">' + task.time + '</div>';
                    }
                    html += '</div>';
                });
            } else {
                html += '<div class="empty-state">暫無已完成任務</div>';
            }
            html += '</div>';

            // Agents
            html += '<div class="card agents-section">';
            html += '<h2>🤖 Agents (' + (data.agents?.length || 1) + ')</h2>';
            if (data.agents?.length) {
                data.agents.forEach(agent => {
                    html += '<div class="agent-item">';
                    html += '<div class="item-header"><span class="item-name">' + agent.name + '</span><span class="badge badge-blue">' + agent.model + '</span></div>';
                    html += '<div class="agent-skills">';
                    if (agent.skills?.length) {
                        agent.skills.forEach(skill => {
                            html += '<span class="skill-tag">' + skill + '</span>';
                        });
                    }
                    html += '</div>';
                    html += '</div>';
                });
            } else {
                html += '<div class="agent-item"><div class="item-header"><span class="item-name">Main Agent</span><span class="badge badge-blue">kimi-coding/k2p5</span></div><div class="agent-skills"><span class="skill-tag">read</span><span class="skill-tag">write</span><span class="skill-tag">edit</span><span class="skill-tag">exec</span><span class="skill-tag">cron</span></div></div>';
            }
            html += '</div>';

            // Token Usage Chart
            html += '<div class="card wide token-chart-section">';
            html += '<h2>📊 Token Usage (過去7天)</h2>';
            html += '<div class="chart-container"><canvas id="tokenChart"></canvas></div>';
            html += '</div>';

            // Skills
            html += '<div class="card wide skills-section">';
            html += '<h2>🛠️ 已安裝 Skills (' + (data.skills?.length || 0) + ')</h2>';
            html += '<div id="skills-container"></div>';
            html += '</div>';

            html += '</div>';
            content.innerHTML = html;

            // Render Chart
            if (data.tokenHistory && data.tokenHistory.length > 0) {
                renderTokenChart(data.tokenHistory);
            }
            
            // Render Skills
            const skillsContainer = document.getElementById('skills-container');
            if (skillsContainer) {
                skillsContainer.innerHTML = renderSkills(data.skills);
            }
        }

        function renderTokenChart(tokenHistory) {
            const ctx = document.getElementById('tokenChart');
            if (!ctx) return;

            if (tokenChart) {
                tokenChart.destroy();
            }

            const sortedData = [...tokenHistory].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
            const labels = sortedData.map(d => new Date(d.timestamp).toLocaleDateString('zh-HK', { month: 'short', day: 'numeric' }));
            const chartData = sortedData.map(d => d.tokens);

            tokenChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Token Usage',
                        data: chartData,
                        borderColor: '#7b2cbf',
                        backgroundColor: 'rgba(123, 44, 191, 0.1)',
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4,
                        pointBackgroundColor: '#7b2cbf',
                        pointBorderColor: '#fff',
                        pointBorderWidth: 2,
                        pointRadius: 4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { grid: { color: 'rgba(255, 255, 255, 0.1)' }, ticks: { color: '#888' } },
                        y: { grid: { color: 'rgba(255, 255, 255, 0.1)' }, ticks: { color: '#888', callback: function(value) { return value.toLocaleString(); } } }
                    }
                }
            });
        }

        function renderSkills(skills) {
            if (!skills || skills.length === 0) {
                return '<div class="empty-state">暫無 Skills</div>';
            }

            const categoryColors = {
                'ai': 'badge-purple', 'communication': 'badge-blue', 'productivity': 'badge-green',
                'utility': 'badge-cyan', 'system': 'badge-orange', 'integration': 'badge-pink',
                'smart-home': 'badge-yellow', 'security': 'badge-red', 'setup': 'badge-indigo', 'database': 'badge-purple'
            };

            const categoryNames = {
                'ai': '🤖 AI', 'communication': '💬 通訊', 'productivity': '📊 生產力', 'utility': '🛠️ 工具',
                'system': '⚙️ 系統', 'integration': '🔗 整合', 'smart-home': '🏠 智能家居',
                'security': '🔒 安全', 'setup': '📋 設置', 'database': '🗄️ 數據庫'
            };

            const grouped = skills.reduce((acc, skill) => {
                const cat = skill.category || 'utility';
                if (!acc[cat]) acc[cat] = [];
                acc[cat].push(skill);
                return acc;
            }, {});

            let html = '';
            Object.entries(grouped).forEach(([category, categorySkills]) => {
                html += '<div class="skill-category">';
                html += '<div class="category-header">' + (categoryNames[category] || category) + '</div>';
                html += '<div class="category-skills">';
                categorySkills.forEach(skill => {
                    html += '<span class="category-skill-tag ' + (categoryColors[category] || 'badge-blue') + '">' + skill.name;
                    if (skill.location !== 'built-in') {
                        html += '<span class="location">(' + skill.location + ')</span>';
                    }
                    html += '</span>';
                });
                html += '</div>';
                html += '</div>';
            });
            return html;
        }

        loadData();
        setInterval(loadData, 30000);
    </script>
</body>
</html>`;
}

// ============ 主入口 ============

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        
        // CORS 預檢
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type'
                }
            });
        }
        
        // Agent API 端點（不需要認證）
        if (url.pathname === '/api/agents/report' && request.method === 'POST') {
            return handleAgentReport(request, env);
        }
        
        // API 獲取主機列表（需要認證）
        if (url.pathname === '/api/hosts') {
            const isAuthenticated = await verifyAuth(request);
            if (!isAuthenticated) {
                return jsonResponse({ error: 'Unauthorized' }, 401);
            }
            const hosts = await getHostsData(env);
            return jsonResponse({ hosts });
        }
        
        // API 獲取統計（需要認證）
        if (url.pathname === '/api/stats') {
            const isAuthenticated = await verifyAuth(request);
            if (!isAuthenticated) {
                return jsonResponse({ error: 'Unauthorized' }, 401);
            }
            const stats = await getStats(env);
            return jsonResponse(stats);
        }
        
        // Logout
        if (url.pathname === '/logout') {
            return new Response('Logged out', {
                status: 302,
                headers: {
                    'Location': '/',
                    'Set-Cookie': 'auth=; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
                },
            });
        }
        
        // Login POST
        if (url.pathname === '/login' && request.method === 'POST') {
            return handleLogin(request);
        }
        
        // Check auth for dashboard
        const isAuthenticated = await verifyAuth(request);
        if (!isAuthenticated) {
            return new Response(loginHTML(), {
                headers: { 'Content-Type': 'text/html' },
            });
        }
        
        // Serve dashboard
        return serveDashboard(env);
    },
};