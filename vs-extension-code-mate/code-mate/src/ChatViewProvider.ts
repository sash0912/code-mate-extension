import * as vscode from 'vscode';
import { AgentManager } from './agents/agentManager';
import { AgentType } from './context/promptBuilder';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'codeMate.chatView';
    private webviewView?: vscode.WebviewView;
    private agentManager: AgentManager;
    private extensionUri: vscode.Uri;

    constructor(extensionUri: vscode.Uri, agentManager: AgentManager) {
        this.extensionUri = extensionUri;
        this.agentManager = agentManager;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.webviewView = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };

        webviewView.webview.html = this.getHtmlContent();

        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'sendMessage':
                    await this.handleUserMessage(message.text, message.agentType || 'chat');
                    break;
                case 'cancelGeneration':
                    this.agentManager.cancelCurrent();
                    break;
                case 'insertCode':
                    this.insertCodeAtCursor(message.code);
                    break;
                case 'copyCode':
                    vscode.env.clipboard.writeText(message.code);
                    vscode.window.showInformationMessage('Code copied to clipboard!');
                    break;
                case 'applyFix':
                    await this.applyCodeFix(message.code);
                    break;
            }
        });
    }

    async triggerAgent(agentType: AgentType): Promise<void> {
        if (this.webviewView) {
            this.webviewView.show?.(true);
        }
        const autoQuery = this.agentManager.getAutoQuery(agentType);
        this.postMessage({ command: 'agentTriggered', agentType, query: autoQuery });
        await this.handleUserMessage(autoQuery, agentType);
    }

    private async handleUserMessage(text: string, agentType: AgentType): Promise<void> {
        this.postMessage({ command: 'responseStart', agentType });

        if (!(await this.agentManager.isOllamaRunning())) {
            this.postMessage({
                command: 'responseError',
                error: 'Ollama is not reachable. Start Ollama with `ollama serve` and reload the extension host.',
            });
            return;
        }

        try {
            const stream = this.agentManager.runAgentStream(agentType, text);
            for await (const token of stream) {
                this.postMessage({ command: 'responseToken', token });
            }
            this.postMessage({ command: 'responseEnd' });
        } catch (err: any) {
            const errorMsg = err.message?.includes('fetch')
                ? `Cannot connect to Ollama. Make sure it is running (ollama serve). Details: ${err.message}`
                : 'Error: ' + err.message;
            this.postMessage({ command: 'responseError', error: errorMsg });
        }
    }

    private insertCodeAtCursor(code: string): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor to insert code into.');
            return;
        }
        editor.edit(editBuilder => {
            editBuilder.insert(editor.selection.active, code);
        });
    }

    private async applyCodeFix(code: string): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor to apply fix to.');
            return;
        }
        if (!editor.selection.isEmpty) {
            await editor.edit(editBuilder => {
                editBuilder.replace(editor.selection, code);
            });
        } else {
            await editor.edit(editBuilder => {
                editBuilder.insert(editor.selection.active, code);
            });
        }
        vscode.window.showInformationMessage('Fix applied!');
    }

    private postMessage(message: any): void {
        this.webviewView?.webview.postMessage(message);
    }

    private getHtmlContent(): string {
        const css = `
:root {
    --bg-primary: var(--vscode-editor-background);
    --bg-secondary: var(--vscode-sideBar-background);
    --bg-input: var(--vscode-input-background);
    --text-primary: var(--vscode-editor-foreground);
    --text-secondary: var(--vscode-descriptionForeground);
    --text-muted: var(--vscode-disabledForeground);
    --border: var(--vscode-panel-border);
    --accent: var(--vscode-button-background);
    --accent-hover: var(--vscode-button-hoverBackground);
    --accent-fg: var(--vscode-button-foreground);
    --error: var(--vscode-errorForeground);
    --code-bg: var(--vscode-textCodeBlock-background);
    --badge-bg: var(--vscode-badge-background);
    --badge-fg: var(--vscode-badge-foreground);
    --scrollbar: var(--vscode-scrollbarSlider-background);
}
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:var(--vscode-font-family); font-size:var(--vscode-font-size);
    background:var(--bg-primary); color:var(--text-primary);
    height:100vh; display:flex; flex-direction:column; overflow:hidden; }
.header { display:flex; align-items:center; justify-content:space-between;
    padding:10px 14px; border-bottom:1px solid var(--border); flex-shrink:0; }
.header-title { font-weight:600; font-size:13px; display:flex; align-items:center; gap:6px; }
.status-dot { width:8px; height:8px; border-radius:50%; background:var(--error); display:inline-block; }
.status-dot.connected { background:#4ec9b0; }
.agent-selector { display:flex; gap:4px; padding:8px 10px;
    border-bottom:1px solid var(--border); overflow-x:auto; flex-shrink:0; }
.agent-btn { background:transparent; border:1px solid var(--border); color:var(--text-secondary);
    border-radius:12px; padding:4px 10px; font-size:11px; cursor:pointer;
    white-space:nowrap; transition:all .15s; font-family:inherit; }
.agent-btn:hover { border-color:var(--accent); color:var(--text-primary); }
.agent-btn.active { background:var(--accent); color:var(--accent-fg); border-color:var(--accent); }
.messages { flex:1; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:12px; }
.messages::-webkit-scrollbar { width:6px; }
.messages::-webkit-scrollbar-thumb { background:var(--scrollbar); border-radius:3px; }
.message { display:flex; flex-direction:column; gap:4px; animation:fadeIn .2s ease-out; }
@keyframes fadeIn { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
.message-label { font-size:11px; font-weight:600; color:var(--text-secondary);
    display:flex; align-items:center; gap:5px; }
.message-label .agent-badge { background:var(--badge-bg); color:var(--badge-fg);
    padding:1px 6px; border-radius:8px; font-size:10px; font-weight:500; }
.message-body { padding:8px 12px; border-radius:8px; font-size:13px;
    line-height:1.55; word-wrap:break-word; overflow-wrap:break-word; }
.message.user .message-body { background:var(--accent); color:var(--accent-fg);
    border-radius:8px 8px 2px 8px; align-self:flex-end; max-width:90%; }
.message.assistant .message-body { background:var(--bg-secondary);
    border:1px solid var(--border); border-radius:2px 8px 8px 8px; }
.message.error .message-body { background:rgba(255,85,85,.1);
    border:1px solid var(--error); color:var(--error); }
.message-body p { margin-bottom:8px; }
.message-body p:last-child { margin-bottom:0; }
.message-body strong { font-weight:600; }
.message-body em { font-style:italic; }
.message-body ul,.message-body ol { padding-left:18px; margin:6px 0; }
.message-body li { margin-bottom:3px; }
.message-body h1,.message-body h2,.message-body h3 { margin:10px 0 5px; font-weight:600; }
.message-body h1 { font-size:16px; }
.message-body h2 { font-size:14px; }
.message-body h3 { font-size:13px; }
.message-body code { background:var(--code-bg); padding:1px 5px; border-radius:3px;
    font-family:var(--vscode-editor-font-family); font-size:12px; }
.code-container { margin:8px 0; border-radius:6px; overflow:hidden; border:1px solid var(--border); }
.code-header { display:flex; justify-content:space-between; align-items:center;
    padding:4px 10px; background:rgba(0,0,0,.2); font-size:11px; color:var(--text-muted); }
.code-actions { display:flex; gap:4px; }
.code-action-btn { background:transparent; border:1px solid var(--border); color:var(--text-secondary);
    padding:2px 8px; border-radius:4px; font-size:10px; cursor:pointer;
    font-family:inherit; transition:all .15s; }
.code-action-btn:hover { background:var(--accent); color:var(--accent-fg); border-color:var(--accent); }
.code-block { background:var(--code-bg); padding:10px 12px; overflow-x:auto;
    font-family:var(--vscode-editor-font-family); font-size:12px; line-height:1.5; white-space:pre; }
.typing { display:flex; align-items:center; gap:4px; padding:8px 12px; }
.typing span { width:6px; height:6px; background:var(--accent); border-radius:50%;
    animation:bounce 1.2s infinite ease-in-out both; }
.typing span:nth-child(2) { animation-delay:.15s; }
.typing span:nth-child(3) { animation-delay:.3s; }
@keyframes bounce { 0%,80%,100%{transform:scale(.6);opacity:.4} 40%{transform:scale(1);opacity:1} }
.welcome { display:flex; flex-direction:column; align-items:center; justify-content:center;
    flex:1; padding:20px; text-align:center; gap:16px; }
.welcome-icon { font-size:40px; opacity:.7; }
.welcome h3 { font-size:16px; font-weight:600; }
.welcome p { color:var(--text-secondary); font-size:12px; line-height:1.5; max-width:260px; }
.quick-actions { display:flex; flex-wrap:wrap; gap:6px; justify-content:center; margin-top:4px; }
.quick-action { background:var(--bg-secondary); border:1px solid var(--border);
    color:var(--text-primary); padding:6px 12px; border-radius:16px; font-size:11px;
    cursor:pointer; transition:all .15s; font-family:inherit; }
.quick-action:hover { background:var(--accent); color:var(--accent-fg); border-color:var(--accent); }
.input-area { padding:10px 12px; border-top:1px solid var(--border); flex-shrink:0; }
.input-wrapper { display:flex; align-items:flex-end; gap:6px; background:var(--bg-input);
    border:1px solid var(--border); border-radius:8px; padding:6px 8px; }
.input-wrapper:focus-within { border-color:var(--accent); }
.input-wrapper textarea { flex:1; background:transparent; border:none; color:var(--text-primary);
    font-family:inherit; font-size:13px; resize:none; outline:none; max-height:120px;
    min-height:20px; line-height:1.4; }
.send-btn,.stop-btn { background:var(--accent); color:var(--accent-fg); border:none;
    border-radius:6px; width:30px; height:30px; cursor:pointer; display:flex;
    align-items:center; justify-content:center; font-size:14px; flex-shrink:0; transition:opacity .15s; }
.send-btn:disabled { opacity:.4; cursor:default; }
.send-btn:hover:not(:disabled),.stop-btn:hover { opacity:.85; }
.stop-btn { background:var(--error); }
.hidden { display:none !important; }`;

        const js = `
const vscode = acquireVsCodeApi();
let currentAgent = 'chat';
let isGenerating = false;
let currentResponseEl = null;
let currentResponseText = '';

document.querySelectorAll('.agent-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.agent-btn').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        currentAgent = btn.dataset.agent;
    });
});

document.querySelectorAll('.quick-action').forEach(function(btn) {
    btn.addEventListener('click', function() {
        var agent = btn.dataset.agent || 'chat';
        document.querySelectorAll('.agent-btn').forEach(function(b) {
            b.classList.toggle('active', b.dataset.agent === agent);
        });
        currentAgent = agent;
        document.getElementById('user-input').value = btn.dataset.prompt;
        sendMessage();
    });
});

var inputEl = document.getElementById('user-input');
var sendBtn = document.getElementById('send-btn');
var stopBtn = document.getElementById('stop-btn');

inputEl.addEventListener('input', function() {
    sendBtn.disabled = !inputEl.value.trim();
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
});

inputEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (inputEl.value.trim() && !isGenerating) { sendMessage(); }
    }
});

sendBtn.addEventListener('click', function() {
    if (inputEl.value.trim() && !isGenerating) { sendMessage(); }
});

stopBtn.addEventListener('click', function() {
    vscode.postMessage({ command: 'cancelGeneration' });
});

function sendMessage() {
    var text = inputEl.value.trim();
    if (!text) return;
    var welcome = document.getElementById('welcome');
    if (welcome) welcome.remove();
    addMessage('user', text);
    vscode.postMessage({ command: 'sendMessage', text: text, agentType: currentAgent });
    inputEl.value = '';
    inputEl.style.height = 'auto';
    sendBtn.disabled = true;
}

function addMessage(role, content, agentType) {
    var messages = document.getElementById('messages');
    var msgEl = document.createElement('div');
    msgEl.className = 'message ' + role;

    var label = document.createElement('div');
    label.className = 'message-label';
    if (role === 'user') {
        label.textContent = 'You';
    } else if (role === 'assistant') {
        var names = { chat:'Chat', explain:'Explain', debug:'Debug',
            generate:'Generate', review:'Review', refactor:'Refactor' };
        var icons = { chat:'\\ud83d\\udcac', explain:'\\ud83d\\udd0d', debug:'\\ud83d\\udc1b',
            generate:'\\u26a1', review:'\\ud83d\\udccb', refactor:'\\u267b\\ufe0f' };
        label.innerHTML = 'Code Mate ' + (agentType
            ? '<span class="agent-badge">' + (icons[agentType]||'') + ' ' + (names[agentType]||agentType) + '</span>'
            : '');
    } else {
        label.textContent = 'Error';
    }

    var body = document.createElement('div');
    body.className = 'message-body';
    body.innerHTML = (role === 'user') ? escapeHtml(content) : renderMarkdown(content);

    msgEl.appendChild(label);
    msgEl.appendChild(body);
    messages.appendChild(msgEl);
    messages.scrollTop = messages.scrollHeight;
    return body;
}

window.addEventListener('message', function(event) {
    var msg = event.data;
    switch (msg.command) {
        case 'responseStart':
            isGenerating = true;
            sendBtn.classList.add('hidden');
            stopBtn.classList.remove('hidden');
            currentResponseText = '';
            var w = document.getElementById('welcome');
            if (w) w.remove();
            currentResponseEl = addMessage('assistant', '', msg.agentType);
            currentResponseEl.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
            break;
        case 'responseToken':
            if (currentResponseEl) {
                currentResponseText += msg.token;
                currentResponseEl.innerHTML = renderMarkdown(currentResponseText);
                document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
            }
            break;
        case 'responseEnd':
            isGenerating = false;
            sendBtn.classList.remove('hidden');
            stopBtn.classList.add('hidden');
            currentResponseEl = null;
            break;
        case 'responseError':
            isGenerating = false;
            sendBtn.classList.remove('hidden');
            stopBtn.classList.add('hidden');
            if (currentResponseEl) {
                currentResponseEl.closest('.message').className = 'message error';
                currentResponseEl.textContent = msg.error;
            } else { addMessage('error', msg.error); }
            currentResponseEl = null;
            break;
        case 'agentTriggered':
            document.querySelectorAll('.agent-btn').forEach(function(b) {
                b.classList.toggle('active', b.dataset.agent === msg.agentType);
            });
            currentAgent = msg.agentType;
            addMessage('user', msg.query);
            break;
    }
});

function renderMarkdown(text) {
    if (!text) return '';
    var html = escapeHtml(text);

    // Code blocks
    var codeBlockRegex = /\\\`\\\`\\\`(\\w*)\\n([\\s\\S]*?)\\\`\\\`\\\`/g;
    html = html.replace(codeBlockRegex, function(match, lang, code) {
        var id = 'code-' + Math.random().toString(36).substr(2, 9);
        return '<div class="code-container">' +
            '<div class="code-header"><span>' + (lang || 'code') + '</span>' +
            '<div class="code-actions">' +
            '<button class="code-action-btn" onclick="handleCodeAction(\\'copy\\',\\'' + id + '\\')">Copy</button>' +
            '<button class="code-action-btn" onclick="handleCodeAction(\\'insert\\',\\'' + id + '\\')">Insert</button>' +
            '</div></div>' +
            '<pre class="code-block" id="' + id + '">' + code.trim() + '</pre></div>';
    });

    // Inline code
    html = html.replace(/\\\`([^\\\`]+)\\\`/g, '<code>$1</code>');

    // Bold
    html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');

    // Italic (single *)
    html = html.replace(/\\*([^*]+?)\\*/g, '<em>$1</em>');

    // Headers
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Unordered lists
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');

    // Numbered lists  
    html = html.replace(/^\\d+\\. (.+)$/gm, '<li>$1</li>');

    // Paragraphs
    html = html.replace(/\\n\\n/g, '</p><p>');
    html = '<p>' + html + '</p>';
    html = html.replace(/<p><\\/p>/g, '');

    return html;
}

function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

window.handleCodeAction = function(action, id) {
    var el = document.getElementById(id);
    if (!el) return;
    if (action === 'copy') {
        vscode.postMessage({ command: 'copyCode', code: el.textContent });
    } else if (action === 'insert') {
        vscode.postMessage({ command: 'insertCode', code: el.textContent });
    }
};`;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Code Mate</title>
    <style>${css}</style>
</head>
<body>
    <div class="header">
        <div class="header-title">
            <span style="font-size:16px">&#129302;</span>
            Code Mate
        </div>
        <span class="status-dot" id="status-dot" title="Disconnected"></span>
    </div>

    <div class="agent-selector">
        <button class="agent-btn active" data-agent="chat">&#128172; Chat</button>
        <button class="agent-btn" data-agent="explain">&#128269; Explain</button>
        <button class="agent-btn" data-agent="debug">&#128027; Debug</button>
        <button class="agent-btn" data-agent="generate">&#9889; Generate</button>
        <button class="agent-btn" data-agent="review">&#128203; Review</button>
        <button class="agent-btn" data-agent="refactor">&#9851;&#65039; Refactor</button>
    </div>

    <div class="messages" id="messages">
        <div class="welcome" id="welcome">
            <div class="welcome-icon">&#129302;</div>
            <h3>Code Mate</h3>
            <p>Your AI coding agent powered by local LLMs. Select code and use the agents above, or chat freely below.</p>
            <div class="quick-actions">
                <button class="quick-action" data-prompt="Explain this code" data-agent="explain">Explain file</button>
                <button class="quick-action" data-prompt="Debug this code and fix errors" data-agent="debug">Debug code</button>
                <button class="quick-action" data-prompt="Review this code" data-agent="review">Review code</button>
                <button class="quick-action" data-prompt="Generate unit tests for this code" data-agent="generate">Write tests</button>
            </div>
        </div>
    </div>

    <div class="input-area">
        <div class="input-wrapper">
            <textarea id="user-input" placeholder="Ask Code Mate..." rows="1"></textarea>
            <button class="send-btn" id="send-btn" disabled title="Send (Enter)">&#9654;</button>
            <button class="stop-btn hidden" id="stop-btn" title="Stop generation">&#9632;</button>
        </div>
    </div>

    <script>${js}</script>
</body>
</html>`;
    }
}
