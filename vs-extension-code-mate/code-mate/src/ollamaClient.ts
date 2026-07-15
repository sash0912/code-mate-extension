import * as vscode from 'vscode';
import { spawn } from 'child_process';

export interface OllamaGenerateRequest {
    model: string;
    prompt: string;
    system?: string;
    stream?: boolean;
    options?: {
        temperature?: number;
        num_predict?: number;
    };
}

export interface OllamaGenerateResponse {
    model: string;
    response: string;
    done: boolean;
}

export interface OllamaModel {
    name: string;
    size: number;
    modified_at: string;
}

export class OllamaClient {
    private getConfig() {
        const config = vscode.workspace.getConfiguration('codeMate');
        return {
            baseUrl: config.get<string>('ollamaUrl', 'http://localhost:11434'),
            model: config.get<string>('model', 'llama3.2'),
            temperature: config.get<number>('temperature', 0.3),
            maxTokens: config.get<number>('maxTokens', 4096),
        };
    }

    /**
     * Check if Ollama is running and reachable
     */
    async isRunning(): Promise<boolean> {
        try {
            const { baseUrl } = this.getConfig();
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);

            const res = await fetch(`${baseUrl}/api/tags`, {
                signal: controller.signal,
            });
            clearTimeout(timeout);
            return res.ok;
        } catch {
            return false;
        }
    }

    /**
     * List available models
     */
    async listModels(): Promise<OllamaModel[]> {
        const { baseUrl } = this.getConfig();
        const res = await fetch(`${baseUrl}/api/tags`);
        if (!res.ok) {
            throw new Error(`Failed to list models: ${res.statusText}`);
        }
        const data = await res.json() as { models: OllamaModel[] };
        return data.models || [];
    }

    /**
     * Generate a complete response (non-streaming)
     */
    async generate(prompt: string, systemPrompt?: string): Promise<string> {
        const config = this.getConfig();
        const body: OllamaGenerateRequest = {
            model: config.model,
            prompt,
            system: systemPrompt,
            stream: false,
            options: {
                temperature: config.temperature,
                num_predict: config.maxTokens,
            },
        };

        const res = await fetch(`${config.baseUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (res.status === 404) {
            return this.runOllamaCliGenerate(prompt, systemPrompt);
        }

        if (!res.ok) {
            throw new Error(`Ollama error: ${res.statusText}`);
        }

        const data = await res.json() as OllamaGenerateResponse;
        return data.response;
    }

    /**
     * Run Ollama CLI as a fallback for generation
     */
    private async runOllamaCliGenerate(prompt: string, systemPrompt?: string): Promise<string> {
        const config = this.getConfig();
        const args = ['run', config.model, '--format', 'json', '--', prompt];
        return new Promise((resolve, reject) => {
            const proc = spawn('ollama', args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (chunk) => stdout += chunk.toString());
            proc.stderr.on('data', (chunk) => stderr += chunk.toString());
            proc.on('error', (err) => reject(new Error(`Ollama CLI failed: ${err.message}`)));
            proc.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`Ollama CLI exited ${code}: ${stderr.trim()}`));
                    return;
                }

                const trimmed = stdout.trim();
                let jsonText = trimmed;

                // If the CLI prints extra text before JSON, extract the last JSON object.
                const lastBrace = trimmed.lastIndexOf('}');
                const firstBrace = trimmed.indexOf('{');
                if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                    jsonText = trimmed.slice(firstBrace, lastBrace + 1);
                }

                try {
                    const parsed = JSON.parse(jsonText);
                    if (typeof parsed === 'object' && parsed !== null) {
                        if ('response' in parsed) {
                            resolve((parsed as any).response);
                            return;
                        }
                        if ('message' in parsed) {
                            resolve((parsed as any).message);
                            return;
                        }
                    }
                } catch {
                    // Ignore parse failures and return raw output.
                }

                resolve(trimmed);
            });
        });
    }

    /**
     * Generate a streaming response, yielding tokens as they arrive
     */
    async *generateStream(
        prompt: string,
        systemPrompt?: string,
        abortSignal?: AbortSignal
    ): AsyncGenerator<string, void, unknown> {
        const config = this.getConfig();
        const body: OllamaGenerateRequest = {
            model: config.model,
            prompt,
            system: systemPrompt,
            stream: true,
            options: {
                temperature: config.temperature,
                num_predict: config.maxTokens,
            },
        };

        const res = await fetch(`${config.baseUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: abortSignal,
        });

        if (res.status === 404) {
            const text = await this.runOllamaCliGenerate(prompt, systemPrompt);
            yield text;
            return;
        }

        if (!res.ok) {
            throw new Error(`Ollama error: ${res.statusText}`);
        }

        const reader = res.body?.getReader();
        if (!reader) {
            throw new Error('No response body');
        }

        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) { break; }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.trim()) { continue; }
                    try {
                        const json = JSON.parse(line) as OllamaGenerateResponse;
                        if (json.response) {
                            yield json.response;
                        }
                        if (json.done) {
                            return;
                        }
                    } catch {
                        // skip malformed JSON lines
                    }
                }
            }

            // Process any remaining buffer
            if (buffer.trim()) {
                try {
                    const json = JSON.parse(buffer) as OllamaGenerateResponse;
                    if (json.response) {
                        yield json.response;
                    }
                } catch {
                    // ignore
                }
            }
        } finally {
            reader.releaseLock();
        }
    }
}
