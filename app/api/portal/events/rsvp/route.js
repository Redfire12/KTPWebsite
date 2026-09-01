import { NextResponse } from 'next/server';
import { getPortalServerClient } from '../../../../lib/portal/server';
import { getPortalMemberContext } from '../../../../lib/portal/member';

// POST /api/portal/events/rsvp
// Body: { event_id: number, status: string }
// status can be 'yes', 'no', or 'maybe'
// Returns JSON { success: true } or error details.

export const dynamic = 'force-dynamic';

async function sendConfirmationEmail(toEmail, event, rsvpStatus) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('RSVP: RESEND_API_KEY not set');
    return false;
  }
  const subject = `RSVP ${rsvpStatus.toUpperCase()} for ${event.title}`;
  const body = `You have successfully RSVP'd "${rsvpStatus}" for the event "${event.title}" scheduled on ${new Date(event.event_date).toLocaleString()}.

If you need to change your response, please visit the event page again.`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'KTP Website <no-reply@ktp-website.vercel.app>',
        to: [toEmail],
        subject,
        text: body,
      }),
    });
    return res.ok;
  } catch (e) {
    console.error('RSVP email error:', e);
    return false;
  }
}

export async function POST(request) {
  try {
    const { event_id, status } = await request.json();
    if (!event_id || !status) {
      return NextResponse.json({ error: 'Missing event_id or status' }, { status: 400 });
    }
    const allowed = ['yes', 'no', 'maybe'];
    if (!allowed.includes(status)) {
      return NextResponse.json({ error: 'Invalid status value' }, { status: 400 });
    }

    // Load member context to ensure authenticated active member
    const ctx = await getPortalMemberContext();
    if (!ctx.authorized || !ctx.member) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const memberUserId = ctx.member.user_id;
    const memberEmail = ctx.member.email;

    const supabase = getPortalServerClient();
    if (!supabase) {
      return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
    }

    // Fetch event details
    const { data: event, error: eventErr } = await supabase
      .from('events')
      .select('id, title, event_date, capacity, rsvp_deadline')
      .eq('id', event_id)
      .maybeSingle();
    if (eventErr || !event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Enforce RSVP deadline if column exists
    if (event.rsvp_deadline) {
      if (new Date() > new Date(event.rsvp_deadline)) {
        return NextResponse.json({ error: 'RSVP deadline passed' }, { status: 400 });
      }
    }

    // Enforce capacity if column exists
    if (event.capacity) {
const { data: _dummy, count: currentYes, error: countErr } = await supabase
      .from('rsvps')
      .select('status', { count: 'exact' })
      .eq('event_id', event_id)
      .eq('status', 'yes');
    if (!countErr && typeof currentYes === 'number') {
      if (currentYes >= event.capacity && status === 'yes') {
        return NextResponse.json({ error: 'Event capacity reached' }, { status: 400 });
      }
    }
    }

    // Upsert RSVP (primary key assumed event_id + member_user_id)
    const { error: upsertErr } = await supabase.from('rsvps').upsert({
      event_id,
      member_user_id: memberUserId,
      status,
    }, { onConflict: ['event_id', 'member_user_id'] });
    if (upsertErr) {
      console.error('RSVP upsert error:', upsertErr);
      return NextResponse.json({ error: 'Failed to save RSVP' }, { status: 500 });
    }

    // Send confirmation email (non-blocking, but we await result)
    if (memberEmail) {
      await sendConfirmationEmail(memberEmail, event, status);
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('RSVP endpoint error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
