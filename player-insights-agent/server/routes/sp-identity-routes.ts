/**
 * Admin CRUD for service-principal personas and the experimental pivot.
 *
 * Under `/api/admin/sp-identity`, so the existing admin prefix refuses a
 * consumer without a second guard. Reads and writes go through the store;
 * minted tokens and secret values never appear in a response.
 */
import { z } from 'zod';
import {
  SpAssignmentWriteSchema,
  SpIdentityModeSchema,
  SpPersonaDefinitionPatchSchema,
  SpPersonaDefinitionWriteSchema,
  SpPersonaPatchSchema,
  SpPersonaWriteSchema,
  type SpIdentityAdminPayload,
  type SpIdentityRosterRow,
} from '../../shared/sp-identity';
import { invalidAdminEmail, recordAdminAction } from '../lib/admin-roles';
import { describeSpTokenMinting } from '../lib/sp-token';
import { discoverSpGrantResources } from '../lib/sp-grant-resources';
import {
  deleteSpPersonaDefinition,
  deleteSpPersona,
  insertSpPersonaDefinition,
  insertSpPersona,
  listSpAssignments,
  listSpPersonaDefinitions,
  listSpPersonas,
  updateSpPersonaDefinition,
  updateSpPersona,
  writeSpAssignment,
  writeSpIdentityEnabled,
  isSpIdentityEnabled,
} from '../lib/sp-identity-store';
import { readRoster } from '../lib/user-roster';
import { userEmail, type InsightsAppKit } from './insights-routes';

async function adminPayload(appkit: InsightsAppKit): Promise<SpIdentityAdminPayload> {
  const [enabled, personas, personaDefinitions, assignments, rosterRead, grantResourceDiscovery] = await Promise.all([
    isSpIdentityEnabled(appkit, { maxAgeMs: 0 }),
    listSpPersonas(appkit),
    listSpPersonaDefinitions(appkit),
    listSpAssignments(appkit),
    readRoster(appkit.lakebase).catch(() => ({ rows: [] as { email: string; role: string }[] })),
    discoverSpGrantResources(appkit)
      .then((resources) => ({ status: 'ready' as const, resources, detail: '' }))
      .catch((error) => ({
        status: 'error' as const,
        resources: [],
        detail: `Configured resources could not be read: ${(error as Error).message}`,
      })),
  ]);
  const assignedByEmail = new Map(assignments.map((row) => [row.email, row.personaId]));
  const roster: SpIdentityRosterRow[] = rosterRead.rows.map((row) => ({
    email: row.email,
    role: row.role,
    personaId: assignedByEmail.get(row.email) ?? null,
  }));
  for (const assignment of assignments) {
    if (roster.some((row) => row.email === assignment.email)) continue;
    roster.push({ email: assignment.email, role: '', personaId: assignment.personaId });
  }
  roster.sort((left, right) => left.email.localeCompare(right.email));
  return {
    enabled,
    minting: describeSpTokenMinting(),
    personas,
    personaDefinitions,
    grantResourceDiscovery,
    assignments,
    roster,
  };
}

export function setupSpIdentityRoutes(appkit: InsightsAppKit): void {
  appkit.server.extend((app) => {
    app.get('/api/admin/sp-identity', async (_req, res) => {
      try {
        res.json(await adminPayload(appkit));
      } catch (error) {
        res.status(503).json({
          error: 'sp_identity_unreadable',
          detail: `Service-principal personas could not be read: ${(error as Error).message}`,
        });
      }
    });

    app.put('/api/admin/sp-identity/mode', async (req, res) => {
      const parsed = SpIdentityModeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_sp_identity_mode', detail: parsed.error.message });
        return;
      }
      const actor = userEmail(req);
      try {
        await writeSpIdentityEnabled(appkit, parsed.data.enabled, actor);
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: parsed.data.enabled ? 'sp-identity-enabled' : 'sp-identity-disabled',
          subject: 'sp-identity',
          detail: parsed.data.enabled
            ? 'Assigned users now run warehouse, Genie, and agent calls as their service-principal persona.'
            : 'Questions again run as the signed-in OAuth user.',
        });
        res.json(await adminPayload(appkit));
      } catch (error) {
        res.status(503).json({
          error: 'sp_identity_store_unavailable',
          detail: `The pivot was not saved: ${(error as Error).message}`,
        });
      }
    });

    app.post('/api/admin/sp-identity/personas', async (req, res) => {
      const parsed = SpPersonaWriteSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_sp_persona', detail: parsed.error.message });
        return;
      }
      const actor = userEmail(req);
      try {
        const persona = await insertSpPersona(appkit, parsed.data, actor);
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'sp-persona-created',
          subject: persona.id,
          detail: `Created service-principal persona ${persona.displayName}.`,
        });
        res.status(201).json(persona);
      } catch (error) {
        res.status(503).json({
          error: 'sp_identity_store_unavailable',
          detail: `The persona was not saved: ${(error as Error).message}`,
        });
      }
    });

    app.post('/api/admin/sp-identity/persona-definitions', async (req, res) => {
      const parsed = SpPersonaDefinitionWriteSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_sp_persona_definition', detail: parsed.error.message });
        return;
      }
      const actor = userEmail(req);
      try {
        const definition = await insertSpPersonaDefinition(appkit, parsed.data, actor);
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'sp-persona-definition-created',
          subject: definition.id,
          detail: `Generated credential-free service-principal configuration ${definition.displayName}.`,
        });
        res.status(201).json(definition);
      } catch (error) {
        res.status(503).json({
          error: 'sp_identity_store_unavailable',
          detail: `The persona configuration was not saved: ${(error as Error).message}`,
        });
      }
    });

    app.patch('/api/admin/sp-identity/persona-definitions/:id', async (req, res) => {
      const parsed = SpPersonaDefinitionPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_sp_persona_definition', detail: parsed.error.message });
        return;
      }
      const id = z.string().trim().min(1).max(80).safeParse(req.params.id);
      if (!id.success) {
        res.status(400).json({ error: 'invalid_sp_persona_definition', detail: 'Missing persona id.' });
        return;
      }
      const actor = userEmail(req);
      try {
        const definition = await updateSpPersonaDefinition(appkit, id.data, parsed.data, actor);
        if (!definition) {
          res.status(404).json({ error: 'sp_persona_definition_missing', detail: 'That persona is not defined.' });
          return;
        }
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'sp-persona-definition-updated',
          subject: definition.id,
          detail: `Updated service-principal configuration ${definition.displayName}.`,
        });
        res.json(definition);
      } catch (error) {
        res.status(503).json({
          error: 'sp_identity_store_unavailable',
          detail: `The persona configuration was not saved: ${(error as Error).message}`,
        });
      }
    });

    app.delete('/api/admin/sp-identity/persona-definitions/:id', async (req, res) => {
      const id = z.string().trim().min(1).max(80).safeParse(req.params.id);
      if (!id.success) {
        res.status(400).json({ error: 'invalid_sp_persona_definition', detail: 'Missing persona id.' });
        return;
      }
      const actor = userEmail(req);
      try {
        const removed = await deleteSpPersonaDefinition(appkit, id.data);
        if (!removed) {
          res.status(404).json({ error: 'sp_persona_definition_missing', detail: 'That persona is not defined.' });
          return;
        }
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'sp-persona-definition-removed',
          subject: id.data,
          detail: 'Removed a credential-free service-principal configuration.',
        });
        res.status(204).end();
      } catch (error) {
        res.status(503).json({
          error: 'sp_identity_store_unavailable',
          detail: `The persona configuration was not removed: ${(error as Error).message}`,
        });
      }
    });

    app.patch('/api/admin/sp-identity/personas/:id', async (req, res) => {
      const parsed = SpPersonaPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_sp_persona', detail: parsed.error.message });
        return;
      }
      const id = z.string().trim().min(1).max(80).safeParse(req.params.id);
      if (!id.success) {
        res.status(400).json({ error: 'invalid_sp_persona', detail: 'Missing persona id.' });
        return;
      }
      const actor = userEmail(req);
      try {
        const persona = await updateSpPersona(appkit, id.data, parsed.data, actor);
        if (!persona) {
          res.status(404).json({ error: 'sp_persona_missing', detail: 'That persona is not defined.' });
          return;
        }
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'sp-persona-updated',
          subject: persona.id,
          detail: `Updated service-principal persona ${persona.displayName}.`,
        });
        res.json(persona);
      } catch (error) {
        res.status(503).json({
          error: 'sp_identity_store_unavailable',
          detail: `The persona was not saved: ${(error as Error).message}`,
        });
      }
    });

    app.delete('/api/admin/sp-identity/personas/:id', async (req, res) => {
      const id = z.string().trim().min(1).max(80).safeParse(req.params.id);
      if (!id.success) {
        res.status(400).json({ error: 'invalid_sp_persona', detail: 'Missing persona id.' });
        return;
      }
      const actor = userEmail(req);
      try {
        const removed = await deleteSpPersona(appkit, id.data);
        if (!removed) {
          res.status(404).json({ error: 'sp_persona_missing', detail: 'That persona is not defined.' });
          return;
        }
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'sp-persona-removed',
          subject: id.data,
          detail: 'Removed a service-principal persona and its assignments.',
        });
        res.status(204).end();
      } catch (error) {
        res.status(503).json({
          error: 'sp_identity_store_unavailable',
          detail: `The persona was not removed: ${(error as Error).message}`,
        });
      }
    });

    app.put('/api/admin/sp-identity/assignments', async (req, res) => {
      const parsed = SpAssignmentWriteSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_sp_assignment', detail: parsed.error.message });
        return;
      }
      const emailFault = invalidAdminEmail(parsed.data.email);
      if (emailFault) {
        res.status(400).json({ error: 'invalid_sp_assignment', detail: emailFault });
        return;
      }
      const actor = userEmail(req);
      try {
        const assignment = await writeSpAssignment(appkit, parsed.data.email, parsed.data.personaId, actor);
        if (parsed.data.personaId && !assignment) {
          res.status(404).json({ error: 'sp_persona_missing', detail: 'That persona is not defined.' });
          return;
        }
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: parsed.data.personaId ? 'sp-persona-assigned' : 'sp-persona-unassigned',
          subject: parsed.data.email,
          detail: parsed.data.personaId
            ? 'Assigned a service-principal persona to this person.'
            : 'This person again runs as themselves over OAuth.',
        });
        res.json({ assignment, payload: await adminPayload(appkit) });
      } catch (error) {
        res.status(503).json({
          error: 'sp_identity_store_unavailable',
          detail: `The assignment was not saved: ${(error as Error).message}`,
        });
      }
    });
  });
}
