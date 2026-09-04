export declare const inject: string[]
export declare function apply(ctx: {
    slots?: {
        inject: (name: string, factory: () => unknown) => unknown
        register: (config: { name: string; id?: string; order?: number }, component: unknown) => unknown
    }
    sessions?: {
        list?: { getSnapshot?: () => { byId?: Record<string, {
            title?: string; cwd?: string; agentPreset?: string
        }>; current?: string } }
        noteAgentPreset?: (id: string, preset: string) => void
    }
    workspaces?: {
        startSession?: (workspaceId?: string) => void
        list?: { getSnapshot?: () => { items?: Array<{ workspaceId: string; sessionIds?: string[] }> } }
    }
}): void
