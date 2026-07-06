// Lightweight AI relationship system. Every combatant belongs to a faction, and
// hostility between factions decides who an agent is willing to attack:
//
//   * PLAYER  — you. Not an AI; never auto-selects targets.
//   * ENEMY   — the standard human hostile. The humans are ONE COOPERATIVE SIDE: an enemy
//               attacks the PLAYER and the BEAST, and NEVER another human. Target PRIORITY
//               (see UeSoldierController.AcquireTarget) weighs threat-by-proximity — a beast
//               and the player are both valid, and whichever is the bigger immediate threat is
//               engaged (so a point-blank player is never ignored for a distant beast).
//   * CHAOTIC — legacy label, kept so old spawn configs still resolve. Behaves exactly like an
//               ENEMY now (attacks the player + beast, never fellow humans); no more free-for-all
//               infighting. Prefer ENEMY for new spawns.
//   * NEUTRAL — passive. Attacks no one until provoked, then retaliates against whoever hit it
//               (handled in TakeHit / Alert(fromDamage)).
//   * BEAST   — the hulking melee creature. It runs its OWN player-hunting AI (it does not use
//               this faction's target selection), so this entry exists mainly so the human
//               factions can mark it hostile and rate it as a major threat.
export const Faction = {
    PLAYER:  'player',
    ENEMY:   'enemy',
    CHAOTIC: 'chaotic',
    NEUTRAL: 'neutral',
    BEAST:   'beast',
};

// The human factions. They form a single cooperative side: a human never attacks another human,
// regardless of which of these labels each one carries. Only the player and the beast are valid
// prey for a human (NEUTRAL aside, which is passive until hit).
const HUMAN_FACTIONS = new Set([Faction.ENEMY, Faction.CHAOTIC, Faction.NEUTRAL]);
export function isHuman(faction){ return HUMAN_FACTIONS.has(faction); }

// Would an agent of faction `from` attack a target of faction `to`?
//   * Humans (ENEMY / CHAOTIC) attack ONLY the player and the beast — never each other (the
//     request: "the human class don't kill each other but attack only the player and the beast").
//   * NEUTRAL never auto-attacks via this table (it only retaliates against whoever shot it, which
//     is handled by provokedBy in AcquireTarget — not here).
//   * PLAYER / BEAST don't use this table at all (the player is you; the beast runs its own AI).
export function isHostile(from, to){
    if(!from || !to || from === to){ return false; }
    switch(from){
        // An active human hostile: the player and the beast are the only valid targets. The
        // explicit `!isHuman(to)` makes the "no human-on-human violence" rule airtight even if a
        // new human faction label is added later.
        case Faction.ENEMY:
        case Faction.CHAOTIC:
            return !isHuman(to) && (to === Faction.PLAYER || to === Faction.BEAST);
        default:
            return false;   // neutral / player / beast: no faction-driven targeting
    }
}

// Is `to` a high-priority (apex) threat for a human faction? The beast is a heavy melee predator,
// so a human rates it as a serious threat — but no longer an *absolute* override (AcquireTarget now
// blends this with distance so a close player still wins over a far beast).
export function isPriorityThreat(to){
    return to === Faction.BEAST;
}
