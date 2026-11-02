/**
 * dsh-cap-manager browser half: mounts the capabilityManager Remote namespace
 * (hand-written contribution — the Host gateway discovers @Remote methods at
 * runtime), then registers the MCP & Skills main panel and its sidebar entry
 * while the current peer may call `capabilityManager/list`.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  CapabilityListResult, ImportSkillsRequest, ListRequest, McpConfigView, TestMcpRequest, TestMcpResult,
  WriteScope,
} from '../types.ts'
import { CapabilitiesPage, type CapabilitiesActions, type CapabilitiesLoadOutcome } from './CapabilitiesPage.tsx'
import { decodeUtf8, downloadBytes, downloadText, zipFiles } from './files.ts'
import { PanelIcon } from './PanelIcon.tsx'
import { en, zh } from './locales.ts'
import type { CapabilityManagerRemote, LocaleLike, RemoteAccessLike, RemoteContribution, SlotsLike } from './shims.ts'

export const NS = 'capManager'

/** The main-panel key; the sidebar entry selects the same id. */
export const PANEL_ID = 'capabilities'

export const inject = ['slots', 'locale', 'remote', 'remoteAccess']

/** One strict passthrough parameter codec; the Host owns real validation. */
function jsonParam(name: string): object {
  return {
    name,
    wire: name,
    source: 'json',
    codec: {
      mode: 'strict',
      typeSymbol: `dsh-cap-manager/${name}`,
      create: () => ({ parse: (value: unknown) => value }),
    },
  }
}

function descriptor(method: string, parameters: readonly string[]): object {
  return {
    id: `dsh-cap-manager/capabilityManager.${method}`,
    service: 'capabilityManager',
    namespace: 'capabilityManager',
    method,
    invocation: { kind: 'direct' },
    parameters: parameters.map(jsonParam),
    result: { mode: 'src-json' },
  }
}

/** Hand-written client contribution for the capabilityManager namespace. */
const contribution: RemoteContribution = {
  package: 'dsh-cap-manager',
  descriptors: [
    descriptor('list', ['request']),
    descriptor('listProjects', []),
    descriptor('setActiveProject', ['request']),
    descriptor('writeMcp', ['request']),
    descriptor('removeMcp', ['request']),
    descriptor('setMcpEnabled', ['request']),
    descriptor('testMcp', ['request']),
    descriptor('writeSkill', ['request']),
    descriptor('setSkillFlagsRpc', ['request']),
    descriptor('removeSkillRpc', ['request']),
    descriptor('readSkillRpc', ['request']),
    descriptor('previewMcpImport', ['request']),
    descriptor('exportMcp', ['request']),
    descriptor('importSkills', ['request']),
    descriptor('readSkillBundleRpc', ['request']),
    descriptor('listTrash', []),
    descriptor('restoreTrash', ['request']),
    descriptor('deleteTrash', ['request']),
    descriptor('clearTrash', []),
    descriptor('listBackups', []),
    descriptor('restoreBackup', ['request']),
    descriptor('deleteBackup', ['request']),
    descriptor('listCcPlugins', ['request']),
    descriptor('installCcPlugin', ['request']),
    descriptor('updateCcPlugin', ['request']),
    descriptor('uninstallCcPlugin', ['request']),
    descriptor('setCcPluginEnabled', ['request']),
  ],
}

/**
 * Register the panel, its sidebar entry, and the dictionaries backing them.
 * @param ctx - the browser plugin context.
 */
export async function apply(ctx: Context): Promise<void> {
  const locale = ctx.get('locale') as LocaleLike
  const slots = ctx.get('slots') as SlotsLike
  const remote = ctx.get('remote') as { $mount(contribution: RemoteContribution): Promise<() => Promise<void>> }
  const remoteAccess = ctx.get('remoteAccess') as RemoteAccessLike

  ctx.effect(() => locale.register(NS, 'zh', zh), 'dsh-cap-manager: zh dictionary')
  ctx.effect(() => locale.register(NS, 'en', en), 'dsh-cap-manager: en dictionary')
  const t = locale.bind(NS)

  await remote.$mount(contribution)

  // The mounted namespace is a Cordis service (`remote.capabilityManager`);
  // reach it through a child context that declares the injection.
  ctx.inject(['remote.capabilityManager'], (nsCtx: Context) => {
    const api = (nsCtx.get('remote') as { capabilityManager: CapabilityManagerRemote }).capabilityManager

    const load = async (request?: ListRequest): Promise<CapabilitiesLoadOutcome> => {
      const result = await api.list(request)
      if (result.ok) return { kind: 'loaded', value: result.value satisfies CapabilityListResult }
      return { kind: 'error', message: `${result.error.code}: ${result.error.message}` }
    }

    const message = (code: string, text: string): string => `${code}: ${text}`
    const actions: CapabilitiesActions = {
      listProjects: async () => {
        const result = await api.listProjects()
        return result.ok ? result.value : Promise.reject(new Error(message(result.error.code, result.error.message)))
      },
      setActiveProject: async root => {
        const result = await api.setActiveProject({ root })
        if (!result.ok) throw new Error(message(result.error.code, result.error.message))
      },
      setEnabled: async (scope: WriteScope, serverName: string, enabled: boolean, projectRoot?: string) => {
        const result = await api.setMcpEnabled({ scope, serverName, enabled, ...(scope === 'project' ? { projectRoot } : {}) })
        return result.ok ? result.value : Promise.reject(new Error(message(result.error.code, result.error.message)))
      },
      write: async (scope: WriteScope, config: McpConfigView, enabled: boolean, projectRoot?: string) => {
        const result = await api.writeMcp({ scope, config, enabled, ...(scope === 'project' ? { projectRoot } : {}) })
        return result.ok ? result.value : Promise.reject(new Error(message(result.error.code, result.error.message)))
      },
      remove: async (scope: WriteScope, serverName: string, projectRoot?: string) => {
        const result = await api.removeMcp({ scope, serverName, ...(scope === 'project' ? { projectRoot } : {}) })
        return result.ok ? result.value : Promise.reject(new Error(message(result.error.code, result.error.message)))
      },
      test: async (config: TestMcpRequest['config']) => {
        const result = await api.testMcp({ config })
        if (result.ok) return result.value satisfies TestMcpResult
        throw new Error(message(result.error.code, result.error.message))
      },
      writeSkill: async request => {
        const result = await api.writeSkill(request)
        return result.ok ? result.value : Promise.reject(new Error(message(result.error.code, result.error.message)))
      },
      setSkillFlags: async (path, flags) => {
        const result = await api.setSkillFlagsRpc({ path, ...flags })
        return result.ok ? result.value : Promise.reject(new Error(message(result.error.code, result.error.message)))
      },
      removeSkill: async path => {
        const result = await api.removeSkillRpc({ path })
        return result.ok ? result.value : Promise.reject(new Error(message(result.error.code, result.error.message)))
      },
      readSkill: async path => {
        const result = await api.readSkillRpc({ path })
        if (result.ok) return result.value satisfies import('../types.ts').ReadSkillResult
        throw new Error(message(result.error.code, result.error.message))
      },
      previewImport: async json => {
        const result = await api.previewMcpImport({ json })
        if (result.ok) return result.value satisfies import('../types.ts').ImportPreview
        throw new Error(message(result.error.code, result.error.message))
      },
      exportMcp: async (projectRoot, serverName) => {
        const request = projectRoot === undefined && serverName === undefined ? undefined
          : { ...(projectRoot === undefined ? {} : { projectRoot }), ...(serverName === undefined ? {} : { serverName }) }
        const result = await api.exportMcp(request)
        if (result.ok) return result.value satisfies import('../types.ts').ExportMcpResult
        throw new Error(message(result.error.code, result.error.message))
      },
      importSkills: async request => {
        const result = await api.importSkills(request satisfies ImportSkillsRequest)
        return result.ok ? result.value : Promise.reject(new Error(message(result.error.code, result.error.message)))
      },
      exportSkill: async path => {
        const result = await api.readSkillBundleRpc({ path })
        if (!result.ok) throw new Error(message(result.error.code, result.error.message))
        const bundle = result.value
        if (bundle.files.length === 1 && bundle.files[0].path.endsWith('.md')) {
          downloadText(`${bundle.name}.md`, decodeUtf8(bundle.files[0].base64), 'text/markdown')
        } else {
          downloadBytes(`${bundle.name}.zip`, zipFiles(bundle.files), 'application/zip')
        }
      },
      listTrash: async () => {
        const result = await api.listTrash()
        return result.ok ? result.value : Promise.reject(new Error(message(result.error.code, result.error.message)))
      },
      restoreTrash: async id => {
        const result = await api.restoreTrash({ id })
        return result.ok ? result.value : Promise.reject(new Error(message(result.error.code, result.error.message)))
      },
      deleteTrash: async id => {
        const result = await api.deleteTrash({ id })
        return result.ok ? result.value : Promise.reject(new Error(message(result.error.code, result.error.message)))
      },
      clearTrash: async () => {
        const result = await api.clearTrash()
        return result.ok ? result.value : Promise.reject(new Error(message(result.error.code, result.error.message)))
      },
      listBackups: async () => {
        const result = await api.listBackups()
        return result.ok ? result.value : Promise.reject(new Error(message(result.error.code, result.error.message)))
      },
      restoreBackup: async file => {
        const result = await api.restoreBackup({ file })
        return result.ok ? result.value : Promise.reject(new Error(message(result.error.code, result.error.message)))
      },
      deleteBackup: async file => {
        const result = await api.deleteBackup({ file })
        if (!result.ok) throw new Error(message(result.error.code, result.error.message))
      },
      listCcPlugins: async (refresh?: boolean) => {
        const result = await api.listCcPlugins(refresh === true ? { refresh: true } : undefined)
        if (result.ok) return result.value satisfies import('../types.ts').CcPluginsListResult
        throw new Error(message(result.error.code, result.error.message))
      },
      installCcPlugin: async name => {
        const result = await api.installCcPlugin({ name })
        if (result.ok) return result.value satisfies import('../types.ts').CcInstallResult
        throw new Error(message(result.error.code, result.error.message))
      },
      updateCcPlugin: async name => {
        const result = await api.updateCcPlugin({ name })
        if (result.ok) return result.value satisfies import('../types.ts').CcInstallResult & { upToDate: boolean }
        throw new Error(message(result.error.code, result.error.message))
      },
      uninstallCcPlugin: async name => {
        const result = await api.uninstallCcPlugin({ name })
        return result.ok ? result.value : Promise.reject(new Error(message(result.error.code, result.error.message)))
      },
      setCcPluginEnabled: async (name, enabled) => {
        const result = await api.setCcPluginEnabled({ name, enabled })
        return result.ok ? result.value : Promise.reject(new Error(message(result.error.code, result.error.message)))
      },
    }

    remoteAccess.whenAccess('capabilityManager/list', function* () {
      yield slots.inject('main', function* () {
        yield slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ t, load, actions }),
        }, CapabilitiesPage)
      })
      yield slots.inject('sidebar.panellist', () => slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 60,
        label: () => t('panel'),
        locale: NS,
      }, PanelIcon))
    })
  })
}
