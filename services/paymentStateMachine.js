// ============================================================
// Machine à états des transactions de paiement (Phase 5.1)
// ============================================================
// Statuts : CREATED, PENDING, PROCESSING, SUCCESS, FAILED,
//           CANCELLED, EXPIRED, REFUNDED.
//
// Chemin nominal :
//   CREATED -> PENDING -> PROCESSING -> SUCCESS
//                                    |-> FAILED
//                                    |-> CANCELLED
//                                    |-> EXPIRED
//
// Transitions complémentaires (pratiques, toujours contrôlées) :
//   CREATED    -> CANCELLED / EXPIRED  (annulation / expiration avant initiation)
//   PENDING    -> CANCELLED / EXPIRED  (annulation / expiration avant traitement)
//   SUCCESS    -> REFUNDED             (remboursement d'un paiement réussi)
//
// Toute autre transition est REJETÉE (les états terminaux FAILED, CANCELLED,
// EXPIRED et REFUNDED sont définitifs).
// ============================================================

const TRANSITIONS = {
    CREATED: ['PENDING', 'CANCELLED', 'EXPIRED'],
    PENDING: ['PROCESSING', 'CANCELLED', 'EXPIRED'],
    PROCESSING: ['SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED'],
    SUCCESS: ['REFUNDED'],
    FAILED: [],
    CANCELLED: [],
    EXPIRED: [],
    REFUNDED: [],
};

const TERMINAL_STATES = ['SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED'];

/** Retourne les statuts accessibles depuis un statut donné. */
function allowedTransitions(from) {
    return TRANSITIONS[from] || [];
}

/** Vrai si la transition `from -> to` est autorisée. */
function canTransition(from, to) {
    return allowedTransitions(from).includes(to);
}

module.exports = { TRANSITIONS, TERMINAL_STATES, allowedTransitions, canTransition };
