'use server';

import { randomBytes } from 'crypto';
import { revalidatePath } from 'next/cache';
import { createClient, hasSupabaseEnv } from '@/lib/supabase/server';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { createPublicClient } from '@/lib/supabase/public';
import { computeClosureCompliance } from '@/lib/business-logic';
import { recomputeExpectedCost } from '@/lib/standard-cost';
import { currentUser, loadApprovedStandardCosts, loadApprovedMaterialCosts } from '../queries';
import { canApprove, canEdit, canSubmit, statusOnSubmit } from '../approval';
import {
  canAcceptProposal,
  canConfirmCm,
  canConfirmFabric,
  canPropose,
  canRejectCost,
  canRenegotiate,
  canSetTarget,
  canSignOff,
  canSubmitRate,
} from '../cost';
import type { ApprovalEntity, PoCategory, PoType, SdRole, SdStatus } from '../types';
import { INWARD_PLAN_STATUSES } from '../types';
import {
  type ActionResult,
  type LinkResult,
  fail,
  done,
  supa,
  writeLog,
  recordCommitment,
  numOrNull,
  dateOrNull,
  textOrNull,
} from './_shared';

const MATERIAL_TYPES = ['raw', 'dyed', 'trim'];

function readMaterialFields(formData: FormData) {
  const type = String(formData.get('material_type') ?? 'raw');
  return {
    material_type: MATERIAL_TYPES.includes(type) ? type : 'raw',
    name: textOrNull(formData.get('name')),
    colour: textOrNull(formData.get('colour')),
    base_fabric_code: textOrNull(formData.get('base_fabric_code')),
    default_uom: textOrNull(formData.get('default_uom')),
    is_active: formData.get('is_active') !== 'false',
    updated_at: new Date().toISOString(),
  };
}

/** Add a NEW material code (raw / dyed / trim). Insert-only; existing code blocked. */
export async function addMaterial(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to edit the material master.');
  }
  const material_code = String(formData.get('material_code') ?? '').trim().toUpperCase();
  if (!material_code) return fail('Material code is required.');
  const fields = readMaterialFields(formData);
  if (fields.material_type === 'dyed' && (!fields.base_fabric_code || !fields.colour)) {
    return fail('A dyed fabric needs both a base fabric and a colour.');
  }

  const supabase = await supa();
  const { error } = await supabase
    .from('sd_material_master')
    .insert({ material_code, ...fields });
  if (error) {
    return fail(
      error.code === '23505'
        ? `Material code “${material_code}” already exists — use a different code.`
        : `Could not add: ${error.message}`,
    );
  }
  revalidatePath('/material-master');
  revalidatePath('/buying-plan');
  return done(`Added ${material_code}.`);
}

/** Update an existing material code's fields (code is the key, never changed). */
export async function updateMaterial(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to edit the material master.');
  }
  const material_code = String(formData.get('material_code') ?? '').trim().toUpperCase();
  if (!material_code) return fail('Material code is required.');
  const fields = readMaterialFields(formData);
  if (fields.material_type === 'dyed' && (!fields.base_fabric_code || !fields.colour)) {
    return fail('A dyed fabric needs both a base fabric and a colour.');
  }

  const supabase = await supa();
  const { data: updated, error } = await supabase
    .from('sd_material_master')
    .update(fields)
    .eq('material_code', material_code)
    .select('material_code');
  if (error) return fail(`Could not save: ${error.message}`);
  if (!updated?.length) return fail('Material code not found.');
  revalidatePath('/material-master');
  revalidatePath('/buying-plan');
  return done(`Saved ${material_code}.`);
}

/** Add a colour to the managed list used to build dyed-fabric codes. */
export async function addColour(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to edit colours.');
  }
  const colour = String(formData.get('colour') ?? '').trim();
  if (!colour) return fail('Colour is required.');

  const supabase = await supa();
  const { error } = await supabase.from('sd_colour_master').insert({ colour });
  if (error) {
    return fail(
      error.code === '23505'
        ? `Colour “${colour}” already exists.`
        : `Could not add: ${error.message}`,
    );
  }
  revalidatePath('/material-master');
  // Active colours populate the Buying Plan material Dyed-line colour picker.
  revalidatePath('/buying-plan');
  return done(`Added ${colour}.`);
}

/** Activate / deactivate a colour. */
export async function setColourActive(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to edit colours.');
  }
  const colour = String(formData.get('colour') ?? '').trim();
  if (!colour) return fail('Invalid colour.');
  const is_active = formData.get('is_active') !== 'false';

  const supabase = await supa();
  const { error } = await supabase
    .from('sd_colour_master')
    .update({ is_active })
    .eq('colour', colour);
  if (error) return fail(`Could not save: ${error.message}`);
  revalidatePath('/material-master');
  // Toggling a colour active/inactive changes the Buying Plan colour picker options.
  revalidatePath('/buying-plan');
  return done(`${colour} ${is_active ? 'activated' : 'deactivated'}.`);
}

/* ================================================================== */
/* Receivable Plan — weekly inputs (no approval)                       */
/* ================================================================== */

