/**
 * dsh-cap-manager Host half: mounts the capabilityManager Remote service that
 * the Web client panel reads. The plugin entry itself is a plain row inserted
 * by this bundle's cordis.patch.yml.
 */

import type { Context } from '@deepseek-ai/cordis'
import { CapabilityManagerService } from './service.ts'

export const name = 'dsh-cap-manager'

export function apply(ctx: Context): void {
  ctx.plugin(CapabilityManagerService)
}
