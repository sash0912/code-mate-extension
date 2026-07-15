import * as vscode from 'vscode';
import { OllamaClient } from '../ollamaClient';
import { getWorkspaceContext } from '../context/workspaceContext';
import { buildPrompt, AgentType } from '../context/promptBuilder';

export interface AgentResponse {
    text: string;
    agentType: AgentType;
}

/**
 * Agent Manager — orchestrates agent execution and routes commands to the right agent
 */
export class AgentManager {
    private ollama: OllamaClient;
    private currentAbortController: AbortController | null = null;

    constructor(ollama: OllamaClient) {
        this.ollama = ollama;
    }

    /**
     * Check whether Ollama is reachable
     */
    async isOllamaRunning(): Promise<boolean> {
        return this.ollama.isRunning();
    }

    /**
     * Cancel any currently running agent task
     */
    cancelCurrent(): void {
        if (this.currentAbortController) {
            this.currentAbortController.abort();
            this.currentAbortController = null;
        }
    }

    /**
     * Run an agent with streaming, yielding tokens as they arrive
     */
    async *runAgentStream(
        agentType: AgentType,
        userQuery: string
    ): AsyncGenerator<string, void, unknown> {
        this.cancelCurrent();
        this.currentAbortController = new AbortController();

        const context = getWorkspaceContext();

        // Validate context for agents that need code
        if (['explain', 'review', 'refactor'].includes(agentType)) {
            if (!context.selectedText && !context.fileContent) {
                yield '⚠️ No code found. Please open a file or select some code first.';
                return;
            }
        }

        if (agentType === 'debug' && context.diagnostics.length === 0 && !context.selectedText) {
            yield '✅ No diagnostics found in the current file. Select code to debug, or wait for VS Code to detect issues.';
            return;
        }

        const { prompt, systemPrompt } = buildPrompt(agentType, userQuery, context);

        try {
            const stream = this.ollama.generateStream(
                prompt,
                systemPrompt,
                this.currentAbortController.signal
            );

            for await (const token of stream) {
                yield token;
            }
        } catch (err: any) {
            if (err.name === 'AbortError') {
                yield '\n\n_⏹ Response cancelled._';
            } else {
                throw err;
            }
        } finally {
            this.currentAbortController = null;
        }
    }

    /**
     * Run an agent and return the full response (non-streaming)
     */
    async runAgent(agentType: AgentType, userQuery: string): Promise<AgentResponse> {
        const context = getWorkspaceContext();
        const { prompt, systemPrompt } = buildPrompt(agentType, userQuery, context);
        const text = await this.ollama.generate(prompt, systemPrompt);
        return { text, agentType };
    }

    /**
     * Quick-run from context menu (gathers context + auto-generates the query)
     */
    getAutoQuery(agentType: AgentType): string {
        const context = getWorkspaceContext();
        const codeRef = context.selectedText ? 'the selected code' : 'this file';

        switch (agentType) {
            case 'explain':
                return `Explain ${codeRef}`;
            case 'debug':
                return `Debug ${codeRef} and fix the errors`;
            case 'review':
                return `Review ${codeRef} for quality, bugs, and improvements`;
            case 'refactor':
                return `Refactor ${codeRef} to be cleaner and more efficient`;
            case 'generate':
                return 'Generate code based on my description';
            default:
                return '';
        }
    }
}
