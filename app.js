        function asadiyaFlotteApp() {
            return {
                // Navigation principale
                mainTab: 'dashboard', // 'dashboard', 'vehicles', 'drivers', 'reservations', 'maintenance', 'incidents', 'accidents', 'documents', 'video'

                // ===== AUTHENTIFICATION & RÔLES (via API backend) =====
                currentUser: null, // { id, username, name, role, title }
                authToken: null,
                loginForm: { username: '', password: '' },
                loginError: '',
                isLoggingIn: false,
                // Comptes de démo affichés sur l'écran de connexion (les mots de passe sont vérifiés côté serveur)
                demoAccounts: [
                    { username: 'admin', password: 'admin123', label: 'Administrateur', icon: 'fa-user-shield', color: 'indigo' },
                    { username: 'gestionnaire', password: 'gest123', label: 'Gestionnaire', icon: 'fa-user-tie', color: 'amber' },
                    { username: 'conducteur', password: 'cond123', label: 'Conducteur', icon: 'fa-user', color: 'emerald' }
                ],

                get isAdmin() { return this.currentUser?.role === 'ADMIN'; },
                get isManager() { return this.currentUser?.role === 'MANAGER'; },
                get isDriver() { return this.currentUser?.role === 'DRIVER'; },
                get isSuperAdmin() { return this.currentUser?.role === 'SUPERADMIN'; },
                get canManageFleet() { return this.isAdmin || this.isManager; },
                get canDeleteDrivers() { return this.isAdmin; },
                get canExportReports() { return this.isAdmin || this.isManager; },

                async login() {
                    this.loginError = '';
                    if (!this.loginForm.username || !this.loginForm.password) {
                        this.loginError = 'Veuillez renseigner l\'identifiant et le mot de passe.';
                        return;
                    }
                    this.isLoggingIn = true;
                    try {
                        const res = await fetch(this.apiUrl('/api/auth/login'), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(this.loginForm)
                        });
                        const data = await res.json();
                        if (!res.ok) {
                            this.loginError = data.error || 'Identifiants incorrects. Veuillez réessayer.';
                            return;
                        }
                        this.authToken = data.token;
                        this.currentUser = data.user;
                        localStorage.setItem(this.SESSION_KEY, data.token);
                        this.loginForm = { username: '', password: '' };
                        this.mainTab = 'dashboard';
                        if (this.isSuperAdmin) {
                            await this.loadOrganizations();
                            await this.loadSuperAdminStats();
                        } else {
                            await this.loadAllData();
                            await this.loadPaymentHistory();
                            setTimeout(() => this.initCharts(), 150);
                        }
                    } catch (e) {
                        console.error(e);
                        this.loginError = 'Impossible de contacter le serveur. Vérifiez qu\'il est bien démarré (voir README backend).';
                    } finally {
                        this.isLoggingIn = false;
                    }
                },

                quickLogin(username) {
                    const acc = this.demoAccounts.find(a => a.username === username);
                    if (!acc) return;
                    this.loginForm = { username: acc.username, password: acc.password };
                    this.login();
                },

                logout() {
                    this.currentUser = null;
                    this.authToken = null;
                    localStorage.removeItem(this.SESSION_KEY);
                    this.mainTab = 'dashboard';
                    this.publicView = 'landing';
                },
                // ===== FIN AUTHENTIFICATION & RÔLES =====

                // ===== PAGE PUBLIQUE & TUNNEL D'INSCRIPTION (SaaS) =====
                publicView: 'landing', // 'landing' | 'login' | 'signup'
                publicPlans: [],
                publicPlansLoading: false,
                publicPlansError: '',
                // Parcours de paiement (préparation uniquement — activé dans une étape ultérieure)
                paymentFlow: { step: 'idle', planCode: null, planName: null, amount: null, currency: 'XOF', txn: null, status: null, canceling: false, launchUrl: null, refreshed: false, refreshingAbonnement: false, refreshError: '' },
                // Modale d'initiation de paiement (Commit 2)
                showPaymentModal: false,
                paymentProvider: null,      // 'mock' | 'wave' | 'orange_money' | 'stripe' | null
                paymentSubmitting: false,
                paymentError: '',
                paymentCreated: null,       // transaction renvoyée par POST /api/payments/create
                // Suivi du paiement (Commit 3) : polling GET /api/payments/:id/check (~4 s)
                pollTimer: null,
                pollInFlight: false,
                signupForm: { name: '', adminName: '', adminUsername: '', adminPassword: '', planCode: 'STARTER' },
                signupError: '',
                isSigningUp: false,
                signupDone: null, // { organizationName, planName, adminUsername, trialEndsAt }

                async loadPublicPlans() {
                    this.publicPlansLoading = true;
                    this.publicPlansError = '';
                    try {
                        const res = await fetch(this.apiUrl('/api/plans/public'));
                        const data = await res.json();
                        if (!res.ok) throw { message: (data && data.error) || 'Impossible de charger les offres.' };
                        this.publicPlans = data || [];
                    } catch (e) {
                        this.publicPlansError = e.message || 'Impossible de charger les offres.';
                    } finally {
                        this.publicPlansLoading = false;
                    }
                },

                showLogin() { this.publicView = 'login'; },
                showLanding() { this.publicView = 'landing'; },

                startSignup(planCode = 'STARTER') {
                    this.signupForm = { name: '', adminName: '', adminUsername: '', adminPassword: '', planCode };
                    this.signupError = '';
                    this.signupDone = null;
                    this.publicView = 'signup';
                },

                fmtPrice(n) {
                    return (Number(n) || 0).toLocaleString('fr-FR');
                },

                formatDateTime(value) {
                    if (!value) return '—';
                    const d = new Date(value);
                    if (isNaN(d.getTime())) return '—';
                    return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                },

                fmtDate(value) {
                    if (!value) return '—';
                    const bare = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
                    if (bare) return bare[3] + '/' + bare[2] + '/' + bare[1];
                    const d = new Date(value);
                    if (isNaN(d.getTime())) return '—';
                    return d.toLocaleDateString('fr-FR');
                },

                fmtFileSize(bytes) {
                    if (bytes == null || isNaN(bytes)) return '';
                    if (bytes < 1024) return bytes + ' o';
                    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' Ko';
                    return (bytes / (1024 * 1024)).toFixed(1) + ' Mo';
                },

                signupPlanId() {
                    const plan = this.publicPlans.find((p) => p.code === this.signupForm.planCode);
                    return plan ? plan.id : null;
                },

                get comparisonFeatures() {
                    const seen = [];
                    for (const p of this.publicPlans) {
                        for (const f of (p.features || [])) {
                            if (!seen.includes(f)) seen.push(f);
                        }
                    }
                    return seen;
                },

                async submitSignup() {
                    this.signupError = '';
                    const f = this.signupForm;
                    if (!f.name || !f.adminName || !f.adminUsername || !f.adminPassword) {
                        this.signupError = 'Tous les champs sont obligatoires.';
                        return;
                    }
                    if (f.adminPassword.length < 6) {
                        this.signupError = 'Le mot de passe doit contenir au moins 6 caractères.';
                        return;
                    }
                    this.isSigningUp = true;
                    try {
                        const res = await fetch(this.apiUrl('/api/auth/signup'), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ ...f, planId: this.signupPlanId() })
                        });
                        const data = await res.json();
                        if (!res.ok) {
                            this.signupError = (data && data.error) || 'Impossible de créer le compte.';
                            return;
                        }
                        this.signupDone = {
                            organizationName: data.organization.name,
                            planName: data.subscription.plan,
                            adminUsername: f.adminUsername,
                            trialEndsAt: data.subscription.endDate,
                        };
                        // Première connexion : on se connecte immédiatement avec les identifiants saisis.
                        this.loginForm = { username: f.adminUsername, password: f.adminPassword };
                        await this.login();
                    } catch (e) {
                        this.signupError = e.message || 'Impossible de créer le compte.';
                    } finally {
                        this.isSigningUp = false;
                    }
                },
                // ===== FIN PAGE PUBLIQUE & TUNNEL D'INSCRIPTION =====

                // ===== ABONNEMENT : ESPACE CLIENT =====
                get clientSubscription() {
                    return this.currentUser && this.currentUser.subscription ? this.currentUser.subscription : null;
                },

                get subscriptionActive() {
                    const s = this.clientSubscription;
                    return !!(s && s.subscription && ['TRIAL', 'ACTIVE', 'PAST_DUE'].includes(s.subscription.status));
                },

                get subscriptionInactive() {
                    return !!this.clientSubscription && !this.subscriptionActive;
                },

                subscriptionStatusColor(status) {
                    const colors = {
                        TRIAL: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
                        ACTIVE: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
                        EXPIRED: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
                        CANCELLED: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
                        PAST_DUE: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
                    };
                    return colors[status] || 'bg-slate-500/15 text-slate-300 border-slate-500/30';
                },

                usagePercent(used, limit) {
                    if (limit == null) return 0;
                    return Math.min(100, Math.round((Number(used) / Math.max(1, Number(limit))) * 100));
                },

                // ===== ABONNEMENT & PAIEMENT : MODALE D'INITIATION =====
                availablePlans() {
                    return (this.publicPlans || []).slice().sort((a, b) => (Number(a.monthlyPrice) || 0) - (Number(b.monthlyPrice) || 0));
                },

                isCurrentPlan(planCode) {
                    const cur = this.clientSubscription && this.clientSubscription.plan;
                    return !!(cur && cur.code === planCode);
                },

                paymentPlanAmount(planCode) {
                    const p = (this.publicPlans || []).find((x) => x.code === planCode);
                    const price = Number((p && p.monthlyPrice) || 0);
                    const months = Number((p && p.durationMonths) || 1);
                    return Math.round(price * months);
                },

                get paymentPlanPrice() {
                    const p = (this.publicPlans || []).find((x) => x.code === this.paymentFlow.planCode);
                    return p ? Number(p.monthlyPrice) || 0 : Number(this.paymentFlow.amount) || 0;
                },

                get paymentPlanMonths() {
                    const p = (this.publicPlans || []).find((x) => x.code === this.paymentFlow.planCode);
                    return p ? Number(p.durationMonths) || 1 : 1;
                },

                preparePaymentPlan(planCode) {
                    if (!this.canManageFleet) return;
                    // Protection : aucun changement de plan pendant un paiement en cours.
                    if (this.paymentInProgress) {
                        this.openPaymentModal(); // reprend le suivi du paiement actif
                        return;
                    }
                    const cur = this.clientSubscription && this.clientSubscription.plan;
                    const p = (this.publicPlans || []).find((x) => x.code === planCode);
                    const plan = p || cur || null;
                    if (!plan) return;
                    this.paymentFlow = {
                        step: 'ready',
                        planCode: plan.code,
                        planName: plan.name,
                        amount: this.paymentPlanAmount(plan.code),
                        currency: 'XOF',
                    };
                    this.openPaymentModal();
                },

                prepareRenewal() {
                    const cur = this.clientSubscription && this.clientSubscription.plan;
                    if (cur) this.preparePaymentPlan(cur.code);
                },

                openPaymentModal() {
                    if (!this.canManageFleet) return;
                    // Réouverture pendant un paiement actif : on reprend le suivi
                    // (et le polling) au lieu de repartir du choix du fournisseur.
                    if (this.paymentFlow && this.paymentFlow.step === 'tracking') {
                        if (this.paymentInProgress) {
                            this.startPaymentPolling();
                        }
                        this.paymentProvider = null;
                        this.paymentSubmitting = false;
                        this.paymentError = '';
                        this.paymentCreated = null;
                        this.showPaymentModal = true;
                        return;
                    }
                    if (!this.paymentFlow || this.paymentFlow.step !== 'ready') {
                        const cur = this.clientSubscription && this.clientSubscription.plan;
                        if (cur) {
                            this.paymentFlow = {
                                step: 'ready',
                                planCode: cur.code,
                                planName: cur.name,
                                amount: this.paymentPlanAmount(cur.code),
                                currency: 'XOF',
                            };
                        }
                    }
                    this.paymentProvider = null;
                    this.paymentSubmitting = false;
                    this.paymentError = '';
                    this.paymentCreated = null;
                    this.showPaymentModal = true;
                },

                closePaymentModal() {
                    // Nettoyage obligatoire : aucun timer ni polling ne doit survivre
                    // à la fermeture. Le suivi (txn/status) est conservé pour pouvoir
                    // reprendre proprement à la réouverture.
                    this.stopPaymentPolling();
                    this.showPaymentModal = false;
                    this.paymentProvider = null;
                    this.paymentSubmitting = false;
                    this.paymentError = '';
                    this.paymentCreated = null;
                },

                resetPaymentFlow() {
                    this.closePaymentModal();
                },

                // Fournisseurs sélectionnables dans la modale. 'mock' (simulateur),
                // Orange Money et Wave sont disponibles ; Stripe arrivera ensuite.
                // L'état réel (désactivé / non configuré) est tranché par le backend
                // (403 / 503 / 501) au moment de POST /api/payments/create.
                paymentMethodAvailable(provider) {
                    return ['mock', 'orange_money', 'wave'].indexOf(provider) !== -1;
                },

                selectPaymentProvider(provider) {
                    if (!this.paymentMethodAvailable(provider)) return;
                    this.paymentProvider = provider;
                    this.paymentError = '';
                },

                paymentProviderLabel(provider) {
                    const labels = {
                        orange_money: 'Orange Money',
                        wave: 'Wave',
                        stripe: 'Carte bancaire',
                        mock: 'Mode test (Mock)',
                    };
                    return labels[provider] || provider;
                },

                // Fournisseur réel (page de paiement hébergée) vs simulateur 'mock'.
                isRealProvider(provider) {
                    return !!provider && provider !== 'mock';
                },

                // URL de paiement hébergée renvoyée par le backend dans
                // providerResponse (orange_money -> paymentUrl ; wave -> waveLaunchUrl).
                paymentLaunchUrl(txn) {
                    const pr = (txn && txn.providerResponse) || {};
                    return pr.paymentUrl || pr.waveLaunchUrl || null;
                },

                // Ouvre la page de paiement hébergée dans un nouvel onglet (ne quitte
                // pas l'application : le polling continue). Si la fenêtre est bloquée,
                // on redirige l'onglet courant (successUrl ramènera l'utilisateur).
                openPaymentPage(url) {
                    if (!url) return;
                    try {
                        const win = window.open(url, '_blank', 'noopener,noreferrer');
                        if (!win) window.location.assign(url);
                    } catch (e) {
                        window.location.assign(url);
                    }
                },

                // Textes de la notice « paiement en cours » (page hébergée ouverte) :
                // libellés dédiés à Wave (Commit 4B), génériques sinon (Orange Money).
                paymentNoticeText() {
                    return this.paymentProvider === 'wave'
                        ? 'La page Wave a été ouverte dans un nouvel onglet. Finalisez votre paiement puis revenez ici.'
                        : 'Une page de paiement sécurisée s\'est ouverte dans un nouvel onglet. Le succès sera confirmé par le fournisseur.';
                },

                // Libellé du bouton de réouverture de la page de paiement hébergée.
                paymentReopenLabel() {
                    return this.paymentProvider === 'wave' ? 'Rouvrir Wave' : 'Rouvrir la page de paiement';
                },

                paymentStatusBadgeClass(status) {
                    const colors = {
                        PENDING: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
                        PROCESSING: 'bg-blue-500/15 text-blue-600 border-blue-500/30',
                        SUCCESS: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
                        FAILED: 'bg-rose-500/15 text-rose-600 border-rose-500/30',
                        CANCELLED: 'bg-slate-500/15 text-slate-600 border-slate-500/30',
                        EXPIRED: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
                        REFUNDED: 'bg-sky-500/15 text-sky-600 border-sky-500/30',
                        CREATED: 'bg-slate-500/15 text-slate-600 border-slate-500/30',
                    };
                    return colors[status] || 'bg-slate-500/15 text-slate-600 border-slate-500/30';
                },

                formatPaymentError(e) {
                    const msg = (e && e.message) ? e.message : 'Erreur inattendue.';
                    // Libellés dédiés au parcours Wave (Commit 4B), indépendants du
                    // texte renvoyé par le backend. Orange Money / mock conservent les
                    // messages génériques.
                    if (this.paymentProvider === 'wave') {
                        if (e && e.code === 'no_payment_url') return 'Impossible d\'obtenir le lien de paiement Wave. Veuillez réessayer.';
                        if (e && e.status === 403) return 'Wave est actuellement indisponible.';
                        if (e && e.status === 503) return 'Wave n\'est pas encore configuré sur le serveur.';
                        if (e && e.status === 501) return 'Le paiement Wave n\'est pas encore disponible.';
                    }
                    if (e && e.code === 'no_payment_url') return 'Le fournisseur n\'a pas fourni d\'URL de paiement. Réessayez ou contactez le support.';
                    if (e && e.networkError) return 'Erreur réseau : impossible de contacter le serveur. Vérifiez que le backend est démarré.';
                    if (e && e.status === 400) return 'Requête invalide : ' + msg;
                    if (e && e.status === 403) return msg;
                    if (e && e.status === 503) return msg;
                    if (e && e.status === 501) return msg;
                    return msg;
                },

                async submitPayment() {
                    if (!this.canManageFleet) return;
                    if (!this.paymentProvider || !this.paymentFlow || this.paymentSubmitting) return;
                    this.paymentSubmitting = true;
                    this.paymentError = '';
                    try {
                        const txn = await this.apiFetch('/api/payments/create', {
                            method: 'POST',
                            body: JSON.stringify({
                                provider: this.paymentProvider,
                                amount: this.paymentFlow.amount,
                                currency: 'XOF',
                                planCode: this.paymentFlow.planCode,
                                subscriptionId: this.clientSubscription && this.clientSubscription.subscription ? this.clientSubscription.subscription.id : undefined,
                                successUrl: window.location.origin + window.location.pathname,
                                errorUrl: window.location.origin + window.location.pathname,
                            })
                        });
                        this.paymentCreated = txn;
                        // Entre en suivi automatique : statut initial + polling.
                        this.paymentFlow.step = 'tracking';
                        this.paymentFlow.txn = txn;
                        this.paymentFlow.status = txn.status || 'PENDING';
                        this.paymentFlow.canceling = false;
                        this.paymentFlow.launchUrl = null;
                        // Provider réel (Orange Money / Wave) : page de paiement hébergée.
                        // La redirection n'est JAMAIS un succès : seul le backend
                        // confirme via /check ou webhook.
                        if (this.isRealProvider(this.paymentProvider)) {
                            const launchUrl = this.paymentLaunchUrl(txn);
                            if (launchUrl) {
                                this.paymentFlow.launchUrl = launchUrl;
                                this.openPaymentPage(launchUrl);
                            } else {
                                // Aucune URL de paiement : la transaction ne peut pas
                                // être poursuivie (ex: session Wave sans wave_launch_url).
                                // Erreur claire et AUCUN polling lancé.
                                this.paymentError = this.formatPaymentError({
                                    code: 'no_payment_url',
                                    message: 'URL de paiement absente.',
                                });
                                return;
                            }
                        }
                        this.startPaymentPolling();
                    } catch (e) {
                        this.paymentError = this.formatPaymentError(e);
                    } finally {
                        this.paymentSubmitting = false;
                    }
                },

                // ===== SUIVI DU PAIEMENT (Commit 3) : polling + états =====
                // États terminaux : plus aucun tick de polling, plus aucun appel réseau.
                get paymentTerminal() {
                    const s = this.paymentFlow && this.paymentFlow.status;
                    return ['SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED'].indexOf(s) !== -1;
                },

                // Un paiement actif existe : en suivi, non terminal, avec une transaction.
                get paymentInProgress() {
                    const f = this.paymentFlow;
                    return !!(f && f.step === 'tracking' && f.txn && f.txn.id && f.status && !this.paymentTerminal);
                },

                paymentStatusTitle(status) {
                    const labels = {
                        PENDING: 'Paiement en attente...',
                        PROCESSING: 'Paiement en cours de traitement...',
                        SUCCESS: 'Paiement réussi',
                        FAILED: 'Paiement échoué',
                        CANCELLED: 'Paiement annulé',
                        EXPIRED: 'Paiement expiré',
                        REFUNDED: 'Paiement remboursé',
                    };
                    return labels[status] || status;
                },

                // Démarre le polling toutes les ~4 s. Protégé contre le double
                // timer et le double polling (pollTimer + pollInFlight).
                startPaymentPolling() {
                    if (this.pollTimer) return;
                    const txn = this.paymentFlow && this.paymentFlow.txn;
                    if (!txn || !txn.id) return;
                    if (this.paymentTerminal) return;
                    this.pollPaymentStatus(); // premier contrôle immédiat
                    this.pollTimer = setInterval(() => this.pollPaymentStatus(), 4000);
                },

                stopPaymentPolling() {
                    if (this.pollTimer) {
                        clearInterval(this.pollTimer);
                        this.pollTimer = null;
                    }
                },

                async pollPaymentStatus() {
                    if (!this.paymentInProgress) return;
                    if (this.pollInFlight) return; // pas de chevauchement de requêtes
                    const txnId = this.paymentFlow.txn.id;
                    this.pollInFlight = true;
                    try {
                        const data = await this.apiFetch('/api/payments/' + txnId + '/check');
                        this.applyPaymentStatus(data);
                    } catch (e) {
                        if (e && e.status === 409) {
                            // Conflit de transition (ex : MOCK passé à PROCESSING par
                            // webhook alors que checkPayment renvoie PENDING) : l'état
                            // autoritaire est relu via le détail de la transaction.
                            try {
                                const detail = await this.apiFetch('/api/payments/' + txnId);
                                this.applyPaymentStatus(detail);
                            } catch (e2) {
                                /* transitoire : on retentera au prochain tick */
                            }
                        } else if (e && (e.status === 401 || e.status === 403 || e.status === 404)) {
                            // Erreur définitive : arrêt du suivi + message.
                            this.stopPaymentPolling();
                            this.paymentError = this.formatPaymentError(e);
                        }
                        // Erreurs transitoires (réseau / 5xx) : état conservé, prochain tick.
                    } finally {
                        this.pollInFlight = false;
                    }
                },

                applyPaymentStatus(data) {
                    if (!data || !data.id) return;
                    this.paymentFlow.txn = data;
                    this.paymentFlow.status = data.status || this.paymentFlow.status;
                    if (this.paymentTerminal) {
                        this.stopPaymentPolling(); // arrêt immédiat sur état terminal
                    }
                    // Succès confirmé par le backend : on recharge l'état officiel
                    // de l'abonnement. Le renouvellement SaaS est fait par le
                    // backend (services/paymentSync) — le frontend ne renouvelle
                    // JAMAIS directement, il relit simplement /api/auth/me.
                    if (this.paymentFlow.status === 'SUCCESS' && !this.paymentFlow.refreshed) {
                        this.paymentFlow.refreshed = true;
                        this.refreshAbonnement();
                    }
                },

                // Annulation demandée par l'utilisateur (PENDING / PROCESSING).
                async cancelPayment() {
                    if (!this.canManageFleet) return;
                    if (!this.paymentInProgress || this.paymentFlow.canceling) return;
                    this.paymentFlow.canceling = true;
                    try {
                        const data = await this.apiFetch('/api/payments/' + this.paymentFlow.txn.id + '/cancel', { method: 'POST' });
                        this.applyPaymentStatus(data);
                    } catch (e) {
                        if (e && e.status === 409) {
                            // Déjà terminal (webhook arrivé avant l'annulation) : relecture.
                            try {
                                const detail = await this.apiFetch('/api/payments/' + this.paymentFlow.txn.id);
                                this.applyPaymentStatus(detail);
                            } catch (e2) {
                                this.paymentError = this.formatPaymentError(e);
                            }
                        } else {
                            this.paymentError = this.formatPaymentError(e);
                        }
                    } finally {
                        this.paymentFlow.canceling = false;
                    }
                },

                // « Réessayer » après FAILED / CANCELLED / EXPIRED : retour au choix du
                // fournisseur, sans créer automatiquement un nouveau paiement.
                retryPayment() {
                    if (!this.canManageFleet) return;
                    this.stopPaymentPolling();
                    const plan = this.paymentFlow && this.paymentFlow.planCode;
                    const cur = this.clientSubscription && this.clientSubscription.plan;
                    const p = (this.publicPlans || []).find((x) => x.code === plan);
                    const target = p || cur;
                    this.paymentFlow = {
                        step: 'ready',
                        planCode: target ? target.code : null,
                        planName: target ? target.name : null,
                        amount: target ? this.paymentPlanAmount(target.code) : null,
                        currency: 'XOF',
                        launchUrl: null,
                    };
                    this.paymentProvider = null;
                    this.paymentError = '';
                },

                // ===== CONFIRMATION & ABONNEMENT (Commit 5) =====
                // Après un paiement SUCCESS, le renouvellement SaaS est effectué par
                // le backend (services/paymentSync.settlePayment). Le frontend ne
                // renouvelle jamais directement : il relit /api/auth/me pour afficher
                // l'état officiel (statut, dates, limites) renvoyé par le serveur.
                async refreshAbonnement() {
                    if (!this.paymentFlow || !this.paymentFlow.txn || !this.paymentFlow.txn.id) return;
                    this.paymentFlow.refreshingAbonnement = true;
                    this.paymentFlow.refreshError = '';
                    try {
                        const data = await this.apiFetch('/api/auth/me');
                        this.currentUser = data.user;
                    } catch (e) {
                        // Non bloquant : le SUCCESS est déjà confirmé par le backend.
                        // On affiche une information sans jamais inventer d'état.
                        this.paymentFlow.refreshError = (e && e.message) || 'Actualisation de l\'abonnement impossible.';
                    } finally {
                        this.paymentFlow.refreshingAbonnement = false;
                    }
                    this.loadPaymentHistory();
                },

                // ===== HISTORIQUE DES PAIEMENTS (Commit 5) =====
                paymentHistory: [],
                paymentHistoryLoading: false,
                paymentHistoryError: '',
                paymentHistoryFilters: { provider: '', status: '' },

                async loadPaymentHistory() {
                    if (this.isSuperAdmin) return;
                    this.paymentHistoryLoading = true;
                    this.paymentHistoryError = '';
                    try {
                        this.paymentHistory = await this.apiFetch('/api/payments/me');
                    } catch (e) {
                        if (e && (e.status === 401 || e.status === 403 || e.status === 404)) {
                            this.paymentHistory = [];
                            return;
                        }
                        this.paymentHistoryError = (e && e.message) || 'Impossible de charger l\'historique des paiements.';
                    } finally {
                        this.paymentHistoryLoading = false;
                    }
                },

                paymentHistoryFiltered() {
                    const f = this.paymentHistoryFilters || {};
                    return (this.paymentHistory || []).filter((t) => {
                        if (f.provider && t.provider !== f.provider) return false;
                        if (f.status && t.status !== f.status) return false;
                        return true;
                    });
                },
                // ===== FIN ABONNEMENT : ESPACE CLIENT =====

                // ===== ESPACE SUPER ADMIN (gestion des organisations / clients) =====
                organizations: [],
                isLoadingOrgs: false,
                showOrgModal: false,
                newOrg: { name: '', adminName: '', adminUsername: '', adminPassword: '' },
                orgError: '',
                orgSearch: '',
                superadminStats: null,
                isLoadingSuperAdmin: false,

                async loadOrganizations() {
                    this.isLoadingOrgs = true;
                    try {
                        this.organizations = await this.apiFetch('/api/organizations');
                    } catch (e) {
                        console.error(e);
                    } finally {
                        this.isLoadingOrgs = false;
                    }
                },

                // Statistiques globales de la plateforme (dashboard SuperAdmin premium)
                async loadSuperAdminStats() {
                    this.isLoadingSuperAdmin = true;
                    try {
                        this.superadminStats = await this.apiFetch('/api/analytics/superadmin/stats');
                        setTimeout(() => this.initSuperAdminCharts(), 150);
                    } catch (e) {
                        console.error(e);
                    } finally {
                        this.isLoadingSuperAdmin = false;
                    }
                },

                async refreshSuperAdmin() {
                    await Promise.all([this.loadOrganizations(), this.loadSuperAdminStats()]);
                },

                get filteredOrganizations() {
                    const q = (this.orgSearch || '').trim().toLowerCase();
                    const list = (this.superadminStats && this.superadminStats.organizations) || this.organizations || [];
                    if (!q) return list;
                    return list.filter(o => (o.name || '').toLowerCase().includes(q));
                },

                fmtNum(n) {
                    return (Number(n) || 0).toLocaleString('fr-FR');
                },

                fmtMoney(n) {
                    return (Number(n) || 0).toLocaleString('fr-FR') + ' FCFA';
                },

                healthBadge(score) {
                    if (score == null) return { label: '—', cls: 'bg-slate-800 text-slate-400' };
                    if (score >= 85) return { label: 'Excellent', cls: 'bg-emerald-500/15 text-emerald-400' };
                    if (score >= 70) return { label: 'Bon', cls: 'bg-amber-500/15 text-amber-400' };
                    return { label: 'À surveiller', cls: 'bg-rose-500/15 text-rose-400' };
                },

                openOrgModal() {
                    this.newOrg = { name: '', adminName: '', adminUsername: '', adminPassword: '' };
                    this.orgError = '';
                    this.showOrgModal = true;
                },

                async createOrganizationSubmit() {
                    this.orgError = '';
                    if (!this.newOrg.name || !this.newOrg.adminName || !this.newOrg.adminUsername || !this.newOrg.adminPassword) {
                        this.orgError = 'Tous les champs sont obligatoires.';
                        return;
                    }
                    try {
                        await this.apiFetch('/api/organizations', {
                            method: 'POST',
                            body: JSON.stringify({
                                name: this.newOrg.name,
                                adminName: this.newOrg.adminName,
                                adminUsername: this.newOrg.adminUsername,
                                adminPassword: this.newOrg.adminPassword
                            })
                        });
                        this.showOrgModal = false;
                        await this.refreshSuperAdmin();
                    } catch (e) {
                        this.orgError = e.message || 'Impossible de créer le client.';
                    }
                },

                async deleteOrganization(id, name) {
                    if (!confirm(`⚠️ Supprimer définitivement le client "${name}" ?\n\nToutes ses données (véhicules, conducteurs, utilisateurs, historique...) seront perdues irrémédiablement.`)) return;
                    try {
                        await this.apiFetch('/api/organizations/' + id, { method: 'DELETE' });
                        await this.refreshSuperAdmin();
                    } catch (e) {
                        alert('Erreur : ' + (e.message || 'suppression impossible.'));
                    }
                },

                // Gestion des mots de passe (dépannage client qui a perdu son accès)
                showOrgUsersModal: false,
                selectedOrgForUsers: null,
                orgUsersList: [],
                isLoadingOrgUsersList: false,
                resetPasswordUserId: null,
                resetPasswordValue: '',
                resetPasswordError: '',

                async openOrgUsersModal(org) {
                    this.selectedOrgForUsers = org;
                    this.orgUsersList = [];
                    this.resetPasswordUserId = null;
                    this.resetPasswordValue = '';
                    this.resetPasswordError = '';
                    this.showOrgUsersModal = true;
                    this.isLoadingOrgUsersList = true;
                    try {
                        this.orgUsersList = await this.apiFetch('/api/organizations/' + org.id + '/users');
                    } catch (e) {
                        console.error(e);
                    } finally {
                        this.isLoadingOrgUsersList = false;
                    }
                },

                startResetPassword(userId) {
                    this.resetPasswordUserId = userId;
                    this.resetPasswordValue = '';
                    this.resetPasswordError = '';
                },

                async confirmResetPassword(userId, username) {
                    this.resetPasswordError = '';
                    if (!this.resetPasswordValue || this.resetPasswordValue.length < 6) {
                        this.resetPasswordError = 'Le mot de passe doit contenir au moins 6 caractères.';
                        return;
                    }
                    try {
                        await this.apiFetch(
                            `/api/organizations/${this.selectedOrgForUsers.id}/users/${userId}/reset-password`,
                            { method: 'PATCH', body: JSON.stringify({ newPassword: this.resetPasswordValue }) }
                        );
                        alert(`✅ Mot de passe de "${username}" réinitialisé avec succès.\n\nNouveau mot de passe : ${this.resetPasswordValue}\n\nCommuniquez-le au client.`);
                        this.resetPasswordUserId = null;
                        this.resetPasswordValue = '';
                    } catch (e) {
                        this.resetPasswordError = e.message || 'Impossible de réinitialiser ce mot de passe.';
                    }
                },
                // ===== FIN ESPACE SUPER ADMIN =====

                // ===== GESTION DES UTILISATEURS (par organisation, réservé Admin) =====
                orgUsers: [],
                isLoadingUsers: false,
                showUserModal: false,
                editingUserId: null,
                newUser: { username: '', password: '', name: '', role: 'DRIVER', title: '' },
                userError: '',

                async loadOrgUsers() {
                    this.isLoadingUsers = true;
                    try {
                        this.orgUsers = await this.apiFetch('/api/users');
                    } catch (e) {
                        console.error(e);
                    } finally {
                        this.isLoadingUsers = false;
                    }
                },

                openUserModal(u = null) {
                    this.userError = '';
                    if (u) {
                        this.editingUserId = u.id;
                        this.newUser = { username: u.username, password: '', name: u.name, role: u.role, title: u.title || '' };
                    } else {
                        this.editingUserId = null;
                        this.newUser = { username: '', password: '', name: '', role: 'DRIVER', title: '' };
                    }
                    this.showUserModal = true;
                },

                async saveUserSubmit() {
                    this.userError = '';
                    if (!this.newUser.username || !this.newUser.name || (!this.editingUserId && !this.newUser.password)) {
                        this.userError = 'Identifiant, nom et mot de passe (à la création) sont obligatoires.';
                        return;
                    }
                    if (this.newUser.password && this.newUser.password.length < 6) {
                        this.userError = 'Le mot de passe doit contenir au moins 6 caractères.';
                        return;
                    }
                    try {
                        const payload = {
                            username: this.newUser.username,
                            name: this.newUser.name,
                            role: this.newUser.role,
                            title: this.newUser.title
                        };
                        if (this.newUser.password) payload.password = this.newUser.password;

                        if (this.editingUserId) {
                            await this.apiFetch('/api/users/' + this.editingUserId, {
                                method: 'PUT',
                                body: JSON.stringify(payload)
                            });
                        } else {
                            await this.apiFetch('/api/users', {
                                method: 'POST',
                                body: JSON.stringify(payload)
                            });
                        }
                        this.showUserModal = false;
                        await this.loadOrgUsers();
                    } catch (e) {
                        this.userError = e.message || 'Impossible d\'enregistrer cet utilisateur.';
                    }
                },

                async deleteUser(id) {
                    if (!confirm('Voulez-vous vraiment supprimer ce compte utilisateur ?')) return;
                    try {
                        await this.apiFetch('/api/users/' + id, { method: 'DELETE' });
                        await this.loadOrgUsers();
                    } catch (e) {
                        alert('Erreur : ' + (e.message || 'suppression impossible.'));
                    }
                },
                // ===== FIN GESTION DES UTILISATEURS =====

                // Filtre de période appliqué aux graphiques du tableau de bord
                dashboardPeriod: 'ALL', // 'ALL', 'MONTH', 'QUARTER', 'YEAR'

                // ===== CENTRE DE PILOTAGE (Phase 7.6) =====
                // Période du Centre : 'today' | '7d' | 'month' | 'quarter' | 'year'
                pilotPeriod: 'month',
                pilotPeriodOptions: [
                    { value: 'today', label: "Aujourd'hui" },
                    { value: '7d', label: '7 jours' },
                    { value: 'month', label: 'Mois' },
                    { value: 'quarter', label: '3 mois' },
                    { value: 'year', label: 'Année' }
                ],
                // Stats carburant alignées sur pilotPeriod (source /api/fuel-logs/stats)
                pilotFuelStats: null,
                pilotFuelStatsLoading: false,

                // Instances Chart.js du Centre de pilotage (Phase 7.6)
                pilotChartCost: null,
                pilotChartConsumption: null,
                pilotChartCostSplit: null,
                pilotChartAvailability: null,
                pilotChartMaintenance: null,
                pilotChartCompliance: null,

                // Références pour les instances Chart.js
                chartFuel: null,
                chartStatus: null,
                chartIncidents: null,
                chartAccidents: null,
                chartMaintenance: null,
                chartTopVehicles: null,
                chartOilChanges: null,
                chartFuelConsumers: null,
                chartOrgGrowth: null,
                chartMrr: null,
                chartFleetByOrg: null,

                // Intervalle standard de vidange (km)
                oilChangeInterval: 10000,

                // Flotte de véhicules avec gestion du kilométrage de vidange
                // Ces tableaux sont désormais alimentés depuis l'API backend (voir loadAllData())
                vehicles: [],
                drivers: [],
                reservations: [],
                maintenances: [],
                incidents: [],
                accidents: [],
                fuelLogs: [],

                // Ventes de véhicules (Phase 7.7 — Commit 3 : frontend)
                sales: [],
                salesTotal: 0,
                salesLoading: false,
                salesError: '',
                showSaleDetailModal: false,
                selectedSale: null,
                showSaleModal: false,
                saleSaving: false,
                saleDeleting: false,
                saleFormError: '',
                editingSaleId: null,
                saleBeingEdited: null,
                newSale: {
                    vehicleId: '', title: '', description: '', mileage: '', year: '',
                    buyerType: 'EXTERNAL', buyerId: '', buyerName: '', buyerPhone: '', buyerEmail: '', buyerAddress: '', buyerIdCard: '',
                    saleDate: '', currency: 'XOF', price: '', tax: 0, fees: 0,
                    paymentMethod: 'CASH', paymentStatus: 'PENDING', paidAmount: 0, deliveryStatus: 'PENDING', deliveryDate: '',
                    status: 'DRAFT', notes: ''
                },

                // Filtres & Recherche
                vehicleSearch: '',
                vehicleFilterStatus: 'ALL',
                saleSearch: '',
                saleFilterStatus: 'ALL',
                salePriceMin: '',
                salePriceMax: '',
                saleBrandModel: '',

                // Modales
                showVehicleModal: false,
                editingVehicleId: null,
                newVehicle: { plate: '', brand: '', model: '', year: 2024, mileage: 0, lastOilChangeKm: 0, fuel: 'Essence', status: 'AVAILABLE', insuranceExpiry: '', registrationExpiry: '', technicalControlExpiry: '', photo: '' },

                showDriverModal: false,
                editingDriverId: null,
                newDriver: { name: '', email: '', phone: '', license: '', status: 'DISPONIBLE', licenseExpiry: '', photo: '' },

                // Fiche complète d'un véhicule (historique regroupé)
                showVehicleDetailModal: false,
                selectedVehicleId: null,

                showReservationModal: false,
                editingReservationId: null,
                newReservation: { vehicleId: '', driverId: '', start: '', end: '', purpose: '' },

                showMaintenanceModal: false,
                editingMaintenanceId: null,
                newMaintenance: { vehicleId: '', type: '', cost: '', date: '', status: 'PLANIFIÉ', provider: '' },

                showIncidentModal: false,
                editingIncidentId: null,
                newIncident: { vehicleId: '', driverId: '', title: '', priority: 'MOYENNE', description: '' },

                showAccidentModal: false,
                editingAccidentId: null,
                newAccident: { vehicleId: '', driverId: '', date: '', location: '', damage: '', thirdParty: 'Oui', report: 'Oui', costEstimate: 0, status: 'DECLARÉ' },

                showOilChangeModal: false,
                oilChangeData: { vehicleId: '', currentKm: 0, cost: 50000, provider: 'Garage agréé' },

                // Gestion des carburants
                showFuelModal: false,
                fuelFilterVehicle: 'ALL',
                newFuelLog: { vehicleId: '', date: '', liters: '', cost: '', mileage: '' },

                // Analytics carburant (Phase 7.3) — données officielles /api/fuel-logs/stats
                fuelStats: null,             // KPI + anomalies + budget pour l'onglet Carburant
                fuelStatsPeriod: 'month',    // today | week | month | prevMonth | year
                fuelStatsLoading: false,
                fuelStatsError: '',
                dashboardFuelStats: null,    // mêmes stats, période alignée sur dashboardPeriod (graphiques)
                dashboardFuelStatsLoading: false,

                // Budget carburant mensuel
                showFuelBudgetModal: false,
                editingFuelBudgetId: null,
                newFuelBudget: { month: '', amount: '' },
                fuelBudgetSaving: false,
                fuelBudgetError: '',

                // --- ONGLET DOCUMENTATION (module documents) ---
                documents: [],
                documentsLoading: false,
                documentsError: '',
                documentsStatsLoading: false,
                documentFilters: { search: '', documentType: '', vehicleId: '', driverId: '', status: '', expiryFrom: '', expiryTo: '' },
                documentPagination: { page: 1, pageSize: 10, total: 0 },
                // Compteurs officiels /api/documents par statut : EXPIRED (< 0 j),
                // CRITICAL (≤ 7 j), SOON (≤ 30 j), OK, UNKNOWN.
                documentStats: { total: 0, ok: 0, critical: 0, soon: 0, expired: 0, unknown: 0 },
                documentsToRenew: [],        // docs à renouveler (EXPIRED / CRITICAL / SOON), triés par urgence
                documentsRenewLoading: false,
                documentTypes: ['Assurance', 'Carte Grise', 'Contrôle Technique', 'Permis', 'Vignette', 'Autorisation', 'Autre'],
                showDocumentModal: false,
                documentModalMode: 'create', // 'create' | 'edit' | 'view'
                documentSelected: null,
                documentForm: { vehicleId: '', driverId: '', documentType: '', documentNumber: '', issueDate: '', expiryDate: '', notes: '' },
                documentFormInitial: null, // instantané du formulaire à l'ouverture (détection de modifications)
                documentOwnerType: 'vehicle', // 'vehicle' | 'driver' (sélection exclusif)
                documentFormLoading: false,
                documentFormSaving: false,
                documentFormError: '',
                documentDeleting: false,
                documentFileSelected: null,
                documentFileProgress: 0,
                documentFileError: '',
                documentFileUploading: false,

                // --- ÉTAT ET LOGIQUE DU LECTEUR VIDÉO ---
                videoTab: 'player', // 'player', 'script'
                isPlaying: false,
                currentSceneIndex: 0,
                currentTime: 0,
                timer: null,
                voiceEnabled: true,
                speechSynth: typeof window !== 'undefined' ? window.speechSynthesis : null,

                scenes: [
                    {
                        title: "Introduction Asadiya Flotte PRO",
                        duration: 8,
                        visual: "Logo animé avec effets d'ondes, présentation du titre et des badges technologiques.",
                        subtitle: "Découvrez Asadiya Flotte PRO, l'application intelligente pour piloter votre flotte automobile.",
                        narration: "Découvrez Asadiya Flotte PRO, l'application complète et moderne pour piloter facilement l'ensemble de votre flotte automobile."
                    },
                    {
                        title: "Tableau de Bord & KPIs",
                        duration: 8,
                        visual: "Affichage des indicateurs de performance, taux de disponibilité et graphiques dynamiques en temps réel.",
                        subtitle: "Visualisez en un coup d'œil l'état global de votre parc grâce aux indicateurs clés.",
                        narration: "Visualisez en un coup d'œil l'état global de votre parc grâce à un tableau de bord clair, des cartes de performance et des graphiques interactifs."
                    },
                    {
                        title: "Alertes Vidanges & Entretien",
                        duration: 10,
                        visual: "Bannière d'alerte rouge clignotante et suivi des kilométrages de vidange par véhicule.",
                        subtitle: "Ne ratez plus aucune vidange grâce au système de suivi préventif automatisé des moteurs.",
                        narration: "Ne ratez plus jamais une échéance de vidange. Notre système calcule automatiquement les seuils kilométriques et vous alerte en temps réel."
                    },
                    {
                        title: "Parc Automobile & Conducteurs",
                        duration: 8,
                        visual: "Cartes des véhicules avec plaques, kilométrage et gestion des profils chauffeurs.",
                        subtitle: "Gérez vos véhicules et vos conducteurs avec un suivi précis des caractéristiques et des permis.",
                        narration: "Gérez facilement vos véhicules et conducteurs, suivez les attributions et contrôlez les habilitations en toute simplicité."
                    },
                    {
                        title: "Planning & Réservations",
                        duration: 8,
                        visual: "Interface de calendrier, validation des missions et prévention des conflits d'agenda.",
                        subtitle: "Planifiez les trajets et validez les réservations en évitant les doublons de calendrier.",
                        narration: "Planifiez vos missions et gérez les réservations. Notre système empêche automatiquement les conflits de planning entre conducteurs."
                    },
                    {
                        title: "Signalements & Accidents",
                        duration: 10,
                        visual: "Formulaires de signalement de pannes et gestion complète des dossiers d'accidents et assurances.",
                        subtitle: "Déclarez les pannes et suivez rigoureusement le traitement des sinistres et des constats.",
                        narration: "Déclarez rapidement les dysfonctionnements et suivez le traitement de vos dossiers de sinistres et d'assurances en cas d'accident."
                    },
                    {
                        title: "Conclusion & Appel à l'action",
                        duration: 8,
                        visual: "Fusée animée, résumé des bénéfices et bouton d'action principal.",
                        subtitle: "Passez à la vitesse supérieure et simplifiez votre gestion dès aujourd'hui avec Asadiya Flotte PRO !",
                        narration: "Passez à la vitesse supérieure et simplifiez la gestion de votre flotte dès aujourd'hui avec Asadiya Flotte PRO !"
                    }
                ],

                get videoTotalDuration() {
                    return this.scenes.reduce((sum, s) => sum + s.duration, 0);
                },

                get videoProgressPercentage() {
                    return (this.currentTime / this.videoTotalDuration) * 100;
                },

                get filteredVehicles() {
                    return this.vehicles.filter(v => {
                        const matchesSearch = v.brand.toLowerCase().includes(this.vehicleSearch.toLowerCase()) ||
                                              v.model.toLowerCase().includes(this.vehicleSearch.toLowerCase()) ||
                                              v.plate.toLowerCase().includes(this.vehicleSearch.toLowerCase());
                        const matchesFilter = this.vehicleFilterStatus === 'ALL' || v.status === this.vehicleFilterStatus;
                        return matchesSearch && matchesFilter;
                    });
                },

                // Véhicules susceptibles d'être proposés à la vente (disponibles uniquement).
                get availableForSaleVehicles() {
                    return this.vehicles.filter(v => v.status === 'AVAILABLE');
                },

                // Véhicules proposables dans le formulaire vente : les disponibles,
                // plus le véhicule déjà lié à la vente en cours de modification
                // (RESERVED : il doit rester sélectionnable sans être libéré).
                get saleFormVehicles() {
                    const list = this.availableForSaleVehicles.slice();
                    if (this.saleBeingEdited && this.saleBeingEdited.vehicleId != null) {
                        const cur = this.vehicles.find(v => v.id === this.saleBeingEdited.vehicleId);
                        if (cur && !list.some(v => v.id === cur.id)) list.push(cur);
                    }
                    return list;
                },

                // Filtres prix min/max et marque/modèle appliqués côté client sur le jeu
                // chargé ; le statut et la recherche sont gérés côté serveur (loadSales).
                get filteredSales() {
                    const min = this.salePriceMin === '' ? null : parseFloat(this.salePriceMin);
                    const max = this.salePriceMax === '' ? null : parseFloat(this.salePriceMax);
                    return this.sales.filter(s => {
                        const total = parseFloat(s.totalPrice) || 0;
                        if (min != null && !isNaN(min) && total < min) return false;
                        if (max != null && !isNaN(max) && total > max) return false;
                        const q = this.saleBrandModel.trim().toLowerCase();
                        if (q) {
                            const v = this.saleVehicle(s);
                            const label = (v ? v.brand + ' ' + v.model : '') + ' ' + (s.vehicle || '');
                            if (!label.toLowerCase().includes(q)) return false;
                        }
                        return true;
                    });
                },

                get availableVehiclesCount() {
                    return this.vehicles.filter(v => v.status === 'AVAILABLE').length;
                },

                get bookedVehiclesCount() {
                    return this.vehicles.filter(v => v.status === 'BOOKED').length;
                },

                get maintenanceVehiclesCount() {
                    return this.vehicles.filter(v => v.status === 'IN_MAINTENANCE').length;
                },

                // GESTION DES ALERTES VIDANGES
                getVehiclesNeedingOilChange() {
                    return this.vehicles.filter(v => v.fuel !== 'Électrique' && (v.nextOilChangeKm - v.mileage) <= 1500);
                },

                getOilChangeStatus(v) {
                    if (v.fuel === 'Électrique') return { label: 'Non applicable', color: 'slate', urgent: false, remaining: 999999 };
                    const remaining = v.nextOilChangeKm - v.mileage;
                    if (remaining <= 0) {
                        return { label: 'VIDANGE DÉPASSÉE (' + Math.abs(remaining).toLocaleString() + ' km de retard)', color: 'rose', urgent: true, remaining };
                    } else if (remaining <= 500) {
                        return { label: 'VIDANGE URGENTE (' + remaining.toLocaleString() + ' km restants)', color: 'rose', urgent: true, remaining };
                    } else if (remaining <= 1500) {
                        return { label: 'VIDANGE PROCHAINE (' + remaining.toLocaleString() + ' km restants)', color: 'amber', urgent: false, remaining };
                    } else {
                        return { label: 'OK (' + remaining.toLocaleString() + ' km restants)', color: 'emerald', urgent: false, remaining };
                    }
                },

                // ===== GESTION DES ALERTES DOCUMENTS (Assurance / Carte Grise / Contrôle Technique / Permis) =====
                // Calcule le statut d'une date de validité : EXPIRED (< 0 j) /
                // CRITICAL (≤ 7 j) / SOON (≤ 30 j) / OK / UNKNOWN. Miroir de la
                // logique backend db/analytics.documentStatus.
                getDocumentStatus(dateStr) {
                    if (!dateStr) return { status: 'UNKNOWN', label: 'Non renseignée', color: 'slate', daysLeft: null };
                    const expiry = new Date(dateStr);
                    if (isNaN(expiry.getTime())) return { status: 'UNKNOWN', label: 'Non renseignée', color: 'slate', daysLeft: null };
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    expiry.setHours(0, 0, 0, 0);
                    const daysLeft = Math.round((expiry - today) / (1000 * 60 * 60 * 24));
                    if (daysLeft < 0) {
                        return { status: 'EXPIRED', label: 'Expiré depuis ' + Math.abs(daysLeft) + ' j', color: 'rose', daysLeft };
                    } else if (daysLeft <= 7) {
                        return { status: 'CRITICAL', label: 'URGENT (' + daysLeft + ' j restants)', color: 'violet', daysLeft };
                    } else if (daysLeft <= 30) {
                        return { status: 'SOON', label: 'Expire dans ' + daysLeft + ' j', color: 'amber', daysLeft };
                    } else {
                        return { status: 'OK', label: 'Valide (' + daysLeft + ' j restants)', color: 'emerald', daysLeft };
                    }
                },

                // Liste des documents (assurance / carte grise / CT) d'un véhicule qui sont expirés ou proches de l'expiration
                getVehicleDocumentAlerts(v) {
                    const docs = [
                        { type: 'Assurance', date: v.insuranceExpiry },
                        { type: 'Carte Grise', date: v.registrationExpiry },
                        { type: 'Contrôle Technique', date: v.technicalControlExpiry }
                    ];
                    return docs
                        .map(d => ({ ...d, ...this.getDocumentStatus(d.date) }))
                        .filter(d => d.status === 'EXPIRED' || d.status === 'SOON');
                },

                // Vue agrégée : tous les véhicules ayant au moins un document expiré/proche de l'expiration
                get vehiclesWithDocumentAlerts() {
                    return this.vehicles
                        .map(v => ({ vehicle: v, alerts: this.getVehicleDocumentAlerts(v) }))
                        .filter(entry => entry.alerts.length > 0);
                },

                // Conducteurs dont le permis est expiré ou expire bientôt
                get driversWithLicenseAlerts() {
                    return this.drivers
                        .map(d => ({ driver: d, status: this.getDocumentStatus(d.licenseExpiry) }))
                        .filter(entry => entry.status.status === 'EXPIRED' || entry.status.status === 'SOON');
                },
                // ===== FIN GESTION DES ALERTES DOCUMENTS =====

                // ===== FICHE COMPLÈTE D'UN VÉHICULE (Historique regroupé) =====
                openVehicleDetail(v) {
                    this.selectedVehicleId = v.id;
                    this.showVehicleDetailModal = true;
                },

                get selectedVehicleDetail() {
                    return this.vehicles.find(v => v.id === this.selectedVehicleId) || null;
                },

                get vehicleDetailMaintenances() {
                    if (!this.selectedVehicleId) return [];
                    return this.maintenances
                        .filter(m => m.vehicleId === this.selectedVehicleId)
                        .sort((a, b) => new Date(b.date) - new Date(a.date));
                },

                get vehicleDetailFuelLogs() {
                    if (!this.selectedVehicleId) return [];
                    return this.fuelLogs
                        .filter(f => f.vehicleId === this.selectedVehicleId)
                        .sort((a, b) => new Date(b.date) - new Date(a.date));
                },

                get vehicleDetailIncidents() {
                    if (!this.selectedVehicleId) return [];
                    return this.incidents
                        .filter(i => i.vehicleId === this.selectedVehicleId)
                        .sort((a, b) => new Date(b.date) - new Date(a.date));
                },

                get vehicleDetailAccidents() {
                    if (!this.selectedVehicleId) return [];
                    return this.accidents
                        .filter(a => a.vehicleId === this.selectedVehicleId)
                        .sort((a, b) => new Date(b.date) - new Date(a.date));
                },

                get vehicleDetailTotalMaintenanceCost() {
                    return this.vehicleDetailMaintenances.reduce((s, m) => s + (m.cost || 0), 0);
                },
                get vehicleDetailTotalFuelCost() {
                    return this.vehicleDetailFuelLogs.reduce((s, f) => s + (f.cost || 0), 0);
                },
                get vehicleDetailTotalAccidentCost() {
                    return this.vehicleDetailAccidents.reduce((s, a) => s + (a.costEstimate || 0), 0);
                },
                // ===== FIN FICHE COMPLÈTE VÉHICULE =====

                // Données dynamiques pour Top Véhicules et Vidanges effectuées
                get topVehiclesData() {
                    const sorted = [...this.vehicles]
                        .map(v => ({ ...v, _mileageNum: parseFloat(v.mileage) || 0 }))
                        .sort((a, b) => b._mileageNum - a._mileageNum)
                        .slice(0, 5);
                    return {
                        labels: sorted.map(v => `${v.brand} ${v.model} (${v.plate})`),
                        data: sorted.map(v => v._mileageNum)
                    };
                },

                // Vidanges effectuées par mois, calculées à partir des vrais entretiens
                // dont le type mentionne "vidange" (au lieu de données fixes)
                get oilChangesByMonth() {
                    const oilChanges = this.periodMaintenances.filter(m =>
                        (m.type || '').toLowerCase().includes('vidange')
                    );
                    const monthly = this.groupByMonth(oilChanges, 'date', null, true);
                    return monthly;
                },

                // ===== FILTRAGE PAR PÉRIODE (Mois / Trimestre / Année / Tout) =====
                isInSelectedPeriod(dateStr) {
                    if (this.dashboardPeriod === 'ALL' || !dateStr) return true;
                    const d = new Date(dateStr);
                    if (isNaN(d.getTime())) return true;
                    const now = new Date();
                    if (this.dashboardPeriod === 'MONTH') {
                        return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
                    }
                    if (this.dashboardPeriod === 'QUARTER') {
                        const quarterOf = m => Math.floor(m / 3);
                        return d.getFullYear() === now.getFullYear() && quarterOf(d.getMonth()) === quarterOf(now.getMonth());
                    }
                    if (this.dashboardPeriod === 'YEAR') {
                        return d.getFullYear() === now.getFullYear();
                    }
                    return true;
                },

                get periodFuelLogs() {
                    return this.fuelLogs.filter(f => this.isInSelectedPeriod(f.date));
                },
                get periodMaintenances() {
                    return this.maintenances.filter(m => this.isInSelectedPeriod(m.date));
                },
                get periodIncidents() {
                    return this.incidents.filter(i => this.isInSelectedPeriod(i.date));
                },
                get periodAccidents() {
                    return this.accidents.filter(a => this.isInSelectedPeriod(a.date));
                },

                // Regroupe une liste d'entrées datées par mois : somme un champ numérique
                // (valueField fourni), ou compte simplement les entrées (countMode=true)
                groupByMonth(items, dateField, valueField, countMode = false) {
                    const monthNames = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
                    const map = {};
                    items.forEach(it => {
                        const d = new Date(it[dateField]);
                        if (isNaN(d.getTime())) return;
                        const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
                        const increment = countMode ? 1 : (parseFloat(it[valueField]) || 0);
                        map[key] = (map[key] || 0) + increment;
                    });
                    const sortedKeys = Object.keys(map).sort();
                    return {
                        labels: sortedKeys.map(k => {
                            const [y, m] = k.split('-');
                            return monthNames[parseInt(m) - 1] + ' ' + y;
                        }),
                        data: sortedKeys.map(k => map[k])
                    };
                },

                get fuelExpensesByMonth() {
                    return this.groupByMonth(this.periodFuelLogs, 'date', 'cost');
                },

                get maintenanceCostByMonth() {
                    return this.groupByMonth(this.periodMaintenances, 'date', 'cost');
                },
                // ===== FIN FILTRAGE PAR PÉRIODE =====


                // Calculs dynamiques pour les graphiques
                get incidentsPriorityCount() {
                    const haute = this.periodIncidents.filter(i => i.priority === 'HAUTE').length;
                    const moyenne = this.periodIncidents.filter(i => i.priority === 'MOYENNE').length;
                    const basse = this.periodIncidents.filter(i => i.priority === 'BASSE').length;
                    return [haute, moyenne, basse];
                },

                get accidentsStatusCount() {
                    const declare = this.periodAccidents.filter(a => a.status === 'DECLARÉ').length;
                    const assurance = this.periodAccidents.filter(a => a.status === 'ASSURANCE').length;
                    const repare = this.periodAccidents.filter(a => a.status === 'RÉPARÉ').length;
                    return [declare, assurance, repare];
                },

                get totalMaintenanceCost() {
                    return this.maintenances.reduce((sum, m) => sum + (parseFloat(m.cost) || 0), 0);
                },

                // GESTION DES CARBURANTS
                get filteredFuelLogs() {
                    const logs = [...this.fuelLogs].sort((a, b) => new Date(b.date) - new Date(a.date));
                    if (this.fuelFilterVehicle === 'ALL') return logs;
                    return logs.filter(f => f.vehicle === this.fuelFilterVehicle);
                },

                get totalFuelCost() {
                    return this.fuelLogs.reduce((sum, f) => sum + (parseFloat(f.cost) || 0), 0);
                },

                get totalFuelLiters() {
                    return this.fuelLogs.reduce((sum, f) => sum + (parseFloat(f.liters) || 0), 0);
                },

                get avgFuelPricePerLiter() {
                    if (this.totalFuelLiters === 0) return 0;
                    return Math.round(this.totalFuelCost / this.totalFuelLiters);
                },

                get fuelVehicleNames() {
                    return [...new Set(this.fuelLogs.map(f => f.vehicle))];
                },

                // Classement des véhicules par volume de carburant consommé (top 5)
                get topFuelConsumersData() {
                    const totals = {};
                    this.periodFuelLogs.forEach(f => {
                        const liters = parseFloat(f.liters) || 0;
                        const key = f.vehicle || 'Véhicule inconnu';
                        totals[key] = (totals[key] || 0) + liters;
                    });
                    const sorted = Object.entries(totals)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 5);
                    return {
                        labels: sorted.map(e => e[0]),
                        data: sorted.map(e => Math.round(e[1] * 10) / 10)
                    };
                },

                // Consommation moyenne (L/100km) calculée à partir des 2 derniers pleins d'un véhicule
                getVehicleConsumption(vehicleName) {
                    const logs = this.fuelLogs
                        .filter(f => f.vehicle === vehicleName)
                        .sort((a, b) => new Date(a.date) - new Date(b.date));
                    if (logs.length < 2) return null;
                    const last = logs[logs.length - 1];
                    const prev = logs[logs.length - 2];
                    const distance = last.mileage - prev.mileage;
                    if (distance <= 0) return null;
                    return ((last.liters / distance) * 100).toFixed(1);
                },

                // ===== ANALYTICS CARBURANT (données officielles /api/fuel-logs/stats) =====

                // Valeur d'un KPI de la période courante (null tant que pas chargé).
                kpiValue(key) {
                    const k = this.fuelStats && this.fuelStats.kpi;
                    return (k && k[key]) ? k[key].value : null;
                },

                // Variation (%) du KPI vs période précédente (null = non calculable).
                kpiPct(key) {
                    const k = this.fuelStats && this.fuelStats.kpi;
                    return (k && k[key]) ? k[key].pct : null;
                },

                // Formatage affichage d'un KPI : valeur + suffixe, ou '—'.
                kpiText(key, suffix, decimals = 0) {
                    const v = this.kpiValue(key);
                    if (v == null) return '—';
                    return v.toLocaleString('fr-FR', { maximumFractionDigits: decimals }) + (suffix || '');
                },

                // Variation en pourcentage (+/-), ou '—'.
                kpiDeltaText(key) {
                    const pct = this.kpiPct(key);
                    if (pct == null) return '—';
                    return (pct > 0 ? '+' : '') + pct.toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' %';
                },

                // Couleur de la variation : une hausse de coût / prix / conso / coût/km
                // est pénalisante (rouge), une baisse positive (vert). Les autres
                // indicateurs (volume, nombre de pleins) restent neutres (indigo).
                kpiDeltaClass(key) {
                    const pct = this.kpiPct(key);
                    if (pct == null || pct === 0) return 'text-slate-400';
                    const penalisant = ['cost', 'avgPricePerLiter', 'avgConsumption', 'costPerKm'];
                    if (penalisant.indexOf(key) !== -1) return pct > 0 ? 'text-rose-600' : 'text-emerald-600';
                    return 'text-indigo-600';
                },

                kpiDeltaTitle(key) {
                    const pct = this.kpiPct(key);
                    return pct == null ? 'Période précédente vide : aucune comparaison' : 'Variation vs période précédente';
                },

                // Résumé compact : nombre de pleins / véhicules sur la période choisie.
                get fuelStatsPeriodSummary() {
                    if (!this.fuelStats || !this.fuelStats.kpi || !this.fuelStats.period) return '';
                    const n = this.fuelStats.kpi.count ? this.fuelStats.kpi.count.value : 0;
                    const v = this.fuelStats.kpi.vehiclesFed ? this.fuelStats.kpi.vehiclesFed.value : 0;
                    return n + ' plein(s) · ' + v + ' véhicule(s) · ' + this.fuelStats.period.label;
                },

                get fuelAnomalies() {
                    return (this.fuelStats && Array.isArray(this.fuelStats.anomalies)) ? this.fuelStats.anomalies : [];
                },

                // Badge global des anomalies : rouge si une anomalie critique existe,
                // ambre si au moins une moyenne, sinon gris (anomalies faibles seules).
                get fuelAnomalyBadgeClass() {
                    const list = this.fuelAnomalies;
                    if (list.some(a => a.severity === 'ÉLEVÉE')) return 'badge-red';
                    if (list.some(a => a.severity === 'MOYENNE')) return 'badge-amber';
                    return 'badge-slate';
                },

                get fuelBudget() {
                    return (this.fuelStats && this.fuelStats.budget) ? this.fuelStats.budget : null;
                },

                get fuelBudgetList() {
                    return (this.fuelStats && Array.isArray(this.fuelStats.budgetList)) ? this.fuelStats.budgetList : [];
                },

                // État du budget du mois en cours (NO_BUDGET | OK | WARNING | OVER).
                get fuelBudgetStatus() {
                    return this.fuelBudget ? this.fuelBudget.status : 'NO_BUDGET';
                },

                // Taux d'utilisation du budget (0-100+), 0 par défaut.
                get fuelBudgetUtilization() {
                    return this.fuelBudget ? (this.fuelBudget.utilization || 0) : 0;
                },

                budgetStatusMeta() {
                    const map = {
                        NO_BUDGET: { cls: 'badge-slate', label: 'Budget non défini' },
                        OK: { cls: 'badge-green', label: 'Dans le budget' },
                        WARNING: { cls: 'badge-amber', label: 'Seuil atteint (≥ 80 %)' },
                        OVER: { cls: 'badge-red', label: 'Budget dépassé' }
                    };
                    return map[this.fuelBudgetStatus] || map.NO_BUDGET;
                },

                // Couleur de la barre de progression selon l'état du budget.
                budgetBarClass() {
                    if (this.fuelBudgetStatus === 'OVER') return 'bg-rose-500';
                    if (this.fuelBudgetStatus === 'WARNING') return 'bg-amber-500';
                    return 'bg-emerald-500';
                },

                // Libellé du mois d'un budget ('2026-08-01' → 'Août 2026').
                fuelBudgetMonthLabel(monthStr) {
                    const m = String(monthStr || '').slice(0, 7);
                    const months = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
                    if (!/^\d{4}-\d{2}$/.test(m)) return monthStr || '—';
                    const y = m.split('-')[0];
                    return months[parseInt(m.split('-')[1], 10) - 1] + ' ' + y;
                },

                // Anomalies : badge de sévérité (style badges existants de la console).
                anomalySeverityMeta(severity) {
                    const map = {
                        'ÉLEVÉE': { cls: 'badge-red', label: 'Critique' },
                        'MOYENNE': { cls: 'badge-amber', label: 'Moyenne' },
                        'FAIBLE': { cls: 'badge-slate', label: 'Faible' }
                    };
                    return map[severity] || { cls: 'badge-slate', label: severity || '—' };
                },

                anomalyTypeLabel(type) {
                    const map = {
                        high_consumption: 'Consommation',
                        mileage_regression: 'Kilométrage',
                        impossible_consumption: 'Kilométrage',
                        mileage_gap: 'Kilométrage',
                        unusual_quantity: 'Volume',
                        abnormal_price: 'Prix',
                        high_cost_per_km: 'Coût/km',
                        close_fills: 'Pleins rapprochés'
                    };
                    return map[type] || 'Autre';
                },

                // Total dépensé sur la période (source officielle /stats).
                get dashboardFuelTotalCost() {
                    const ch = this.dashboardFuelStats && this.dashboardFuelStats.charts && this.dashboardFuelStats.charts.costByMonth;
                    if (ch && Array.isArray(ch.data)) return ch.data.reduce((s, v) => s + (Number(v) || 0), 0);
                    const local = this.fuelExpensesByMonth;
                    return (Array.isArray(local.data) ? local.data : []).reduce((s, v) => s + (Number(v) || 0), 0);
                },

                get dashboardFuelTotalText() {
                    return Math.round(this.dashboardFuelTotalCost).toLocaleString('fr-FR') + ' FCFA';
                },

                async initApp() {
                    this.$watch('mainTab', (tab) => {
                        if (tab === 'dashboard') {
                            setTimeout(() => {
                                this.initCharts();
                            }, 50);
                        }
                        if (tab === 'users') {
                            this.loadOrgUsers();
                        }
                        if (tab === 'documents') {
                            this.refreshDocuments();
                        }
                    });

                    this.$watch('dashboardPeriod', () => {
                        this.loadDashboardFuelStats().then(() => {
                            if (this.mainTab === 'dashboard') {
                                this.initCharts();
                            }
                        });
                    });

                    // Centre de pilotage : recharger les stats carburant alignées
                    // sur la période pilotée par le sélecteur puis redessiner les
                    // graphiques de la section.
                    this.$watch('pilotPeriod', () => {
                        this.loadPilotFuelStats().then(() => {
                            if (this.mainTab === 'dashboard') {
                                this.initPilotCharts();
                            }
                        });
                    });

                    // Période des statistiques carburant (onglet Carburant)
                    this.$watch('fuelStatsPeriod', () => {
                        this.loadFuelStats();
                    });

                    // Redessine les graphiques lors du changement de thème clair/sombre :
                    // la palette chart.js est recalculée selon html[data-theme].
                    if (window.addEventListenerThemeChange) {
                        window.addEventListenerThemeChange(() => {
                            if (this.isSuperAdmin) {
                                this.initSuperAdminCharts();
                            } else {
                                this.initCharts();
                            }
                        });
                    }

                    // Charge les offres publiques pour la page tarifs (page landing).
                    this.loadPublicPlans();

                    // Tente de restaurer une session existante (token JWT sauvegardé)
                    await this.restoreSession();
                },

                // ===== CONNEXION À L'API BACKEND =====
                SESSION_KEY: 'asadiya_flotte_pro_token_v1',
                // Laissez vide si index.html est servi par le backend lui-même (même origine).
                // Sinon renseignez l'URL complète du serveur, ex: 'http://localhost:4000'
                apiBaseUrl: '',
                isLoadingData: false,
                apiConnectionError: '',

                apiUrl(path) {
                    return this.apiBaseUrl + path;
                },

                // Wrapper fetch() : ajoute le token, gère le JSON et les erreurs communes
                async apiFetch(path, options = {}) {
                    const headers = Object.assign(
                        { 'Content-Type': 'application/json' },
                        this.authToken ? { 'Authorization': 'Bearer ' + this.authToken } : {},
                        options.headers || {}
                    );
                    let res;
                    try {
                        res = await fetch(this.apiUrl(path), { ...options, headers });
                    } catch (e) {
                        throw { networkError: true, message: 'Impossible de contacter le serveur (backend démarré ?).' };
                    }
                    if (res.status === 401) {
                        // Session expirée ou invalide : déconnexion
                        this.logout();
                        throw { message: 'Session expirée. Veuillez vous reconnecter.' };
                    }
                    if (res.status === 204) return null;
                    let data = null;
                    try { data = await res.json(); } catch (e) { /* pas de corps JSON */ }
                    if (!res.ok) {
                        throw { message: (data && data.error) || `Erreur serveur (${res.status})`, conflict: data && data.conflict, code: data && data.code, details: data && data.details, status: res.status };
                    }
                    return data;
                },

                // ===== CENTRE DE PILOTAGE (Phase 7.6) =====

                // Bornes [from, to] de la période du Centre pour un offset donné
                // (0 = période courante, 1 = période précédente de même durée).
                pilotPeriodRange(period, offset) {
                    const now = new Date();
                    const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
                    const endOfDay = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
                    if (period === 'today') {
                        const today = startOfDay(now);
                        if (offset === 1) {
                            const prev = new Date(today); prev.setDate(prev.getDate() - 1);
                            return { from: prev, to: endOfDay(new Date(today.getTime() - 1)) };
                        }
                        return { from: today, to: now };
                    }
                    if (period === '7d') {
                        const end = now;
                        const start = startOfDay(new Date(now.getTime() - 6 * 86400000));
                        if (offset === 1) {
                            const prevStart = new Date(start.getTime() - 7 * 86400000);
                            return { from: prevStart, to: new Date(start.getTime() - 1) };
                        }
                        return { from: start, to: end };
                    }
                    if (period === 'month') {
                        const start = new Date(now.getFullYear(), now.getMonth(), 1);
                        if (offset === 1) {
                            const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                            return { from: prevStart, to: new Date(start.getTime() - 1) };
                        }
                        return { from: start, to: now };
                    }
                    if (period === 'quarter') {
                        const q = Math.floor(now.getMonth() / 3);
                        const start = new Date(now.getFullYear(), q * 3, 1);
                        if (offset === 1) {
                            const prevMonthStart = q === 0 ? 9 : (q - 1) * 3;
                            const prevYear = q === 0 ? now.getFullYear() - 1 : now.getFullYear();
                            const prevStart = new Date(prevYear, prevMonthStart, 1);
                            return { from: prevStart, to: new Date(start.getTime() - 1) };
                        }
                        return { from: start, to: now };
                    }
                    if (period === 'year') {
                        const start = new Date(now.getFullYear(), 0, 1);
                        if (offset === 1) {
                            const prevStart = new Date(now.getFullYear() - 1, 0, 1);
                            return { from: prevStart, to: new Date(start.getTime() - 1) };
                        }
                        return { from: start, to: now };
                    }
                    return { from: null, to: now };
                },

                // True si dateStr appartient à la période courante (offset 0)
                // ou à la période précédente équivalente (offset 1).
                isInPilotRange(dateStr, offset) {
                    if (!dateStr) return false;
                    const d = new Date(dateStr);
                    if (isNaN(d.getTime())) return false;
                    const { from, to } = this.pilotPeriodRange(this.pilotPeriod, offset || 0);
                    if (!from) return true;
                    return d >= from && d <= to;
                },

                // Évolution en % entre deux valeurs ; null si non calculable.
                pilotDelta(current, previous) {
                    if (current == null || previous == null) return null;
                    if (previous === 0) return current === 0 ? 0 : null;
                    return Math.round(((current - previous) / previous) * 1000) / 10;
                },

                // Maintenances non effectuées dont la date est déjà passée.
                pilotOverdueMaintenances() {
                    const today = new Date(); today.setHours(0, 0, 0, 0);
                    return this.maintenances.filter(m => {
                        if (m.status === 'EFFECTUÉ') return false;
                        const d = new Date(m.date);
                        if (isNaN(d.getTime())) return false;
                        return d < today;
                    });
                },

                // Conformité documents : véhicules (assurance, carte grise, CT)
                // + conducteurs (permis). Dénominateur = documents renseignés.
                // Le niveau CRITICAL (≤ 7 j) est compté séparément de SOON.
                get pilotCompliance() {
                    let valid = 0, soon = 0, critical = 0, expired = 0;
                    const docs = [];
                    this.vehicles.forEach(v => {
                        ['insuranceExpiry', 'registrationExpiry', 'technicalControlExpiry'].forEach(k => {
                            if (v[k]) docs.push({ label: k, date: v[k] });
                        });
                    });
                    this.drivers.forEach(dr => {
                        if (dr.licenseExpiry) docs.push({ label: 'licenseExpiry', date: dr.licenseExpiry });
                    });
                    docs.forEach(doc => {
                        const st = this.getDocumentStatus(doc.date);
                        if (st.status === 'OK') valid++;
                        else if (st.status === 'SOON') soon++;
                        else if (st.status === 'CRITICAL') critical++;
                        else if (st.status === 'EXPIRED') expired++;
                    });
                    const total = valid + soon + critical + expired;
                    return {
                        valid, soon, critical, expired, total,
                        rate: total > 0 ? Math.round((valid / total) * 100) : null
                    };
                },

                // Filtrage des données locales par période (offset 0/1).
                get pilotFuelLogs() { return this.fuelLogs.filter(f => this.isInPilotRange(f.date, 0)); },
                get pilotFuelLogsPrev() { return this.fuelLogs.filter(f => this.isInPilotRange(f.date, 1)); },
                get pilotMaintenances() { return this.maintenances.filter(m => this.isInPilotRange(m.date, 0)); },
                get pilotMaintenancesPrev() { return this.maintenances.filter(m => this.isInPilotRange(m.date, 1)); },
                get pilotAccidents() { return this.accidents.filter(a => this.isInPilotRange(a.date, 0)); },
                get pilotAccidentsPrev() { return this.accidents.filter(a => this.isInPilotRange(a.date, 1)); },

                // Coûts agrégés de la période courante vs période précédente.
                get pilotFuelCost() { return this.pilotFuelLogs.reduce((s, f) => s + (parseFloat(f.cost) || 0), 0); },
                get pilotFuelCostPrev() { return this.pilotFuelLogsPrev.reduce((s, f) => s + (parseFloat(f.cost) || 0), 0); },
                get pilotMaintenanceCost() { return this.pilotMaintenances.reduce((s, m) => s + (parseFloat(m.cost) || 0), 0); },
                get pilotMaintenanceCostPrev() { return this.pilotMaintenancesPrev.reduce((s, m) => s + (parseFloat(m.cost) || 0), 0); },
                get pilotAccidentCost() { return this.pilotAccidents.reduce((s, a) => s + (parseFloat(a.costEstimate) || 0), 0); },
                get pilotAccidentCostPrev() { return this.pilotAccidentsPrev.reduce((s, a) => s + (parseFloat(a.costEstimate) || 0), 0); },
                get pilotTotalCost() { return this.pilotFuelCost + this.pilotMaintenanceCost + this.pilotAccidentCost; },
                get pilotTotalCostPrev() { return this.pilotFuelCostPrev + this.pilotMaintenanceCostPrev + this.pilotAccidentCostPrev; },

                // Métadonnées visuelles d'un état KPI (pastille + couleurs).
                pilotStateMeta(state) {
                    const map = {
                        normal: { dot: 'bg-emerald-500', text: 'text-slate-500' },
                        attention: { dot: 'bg-amber-500', text: 'text-amber-600' },
                        critical: { dot: 'bg-rose-500', text: 'text-rose-600' }
                    };
                    return map[state] || map.normal;
                },

                pilotColorMeta(color) {
                    const map = {
                        indigo: 'bg-indigo-50 text-indigo-600 border-indigo-100',
                        emerald: 'bg-emerald-50 text-emerald-600 border-emerald-100',
                        amber: 'bg-amber-50 text-amber-600 border-amber-100',
                        rose: 'bg-rose-50 text-rose-600 border-rose-100',
                        sky: 'bg-sky-50 text-sky-600 border-sky-100',
                        violet: 'bg-violet-50 text-violet-600 border-violet-100'
                    };
                    return map[color] || map.indigo;
                },

                // Tableau des cartes KPI du Centre de pilotage (ordre d'affichage).
                get pilotKpis() {
                    const total = this.vehicles.length;
                    const avail = this.availableVehiclesCount;
                    const immob = this.maintenanceVehiclesCount;
                    const availRate = total > 0 ? Math.round((avail / total) * 100) : 0;
                    const compliance = this.pilotCompliance;
                    const overdue = this.pilotOverdueMaintenances().length;
                    const consoKpi = (this.pilotFuelStats && this.pilotFuelStats.kpi && this.pilotFuelStats.kpi.avgConsumption) || null;
                    const conso = consoKpi ? consoKpi.value : null;

                    const deltaOf = (cur, prev) => {
                        const pct = this.pilotDelta(cur, prev);
                        if (pct == null) return { text: '—', arrow: '', cls: 'text-slate-400' };
                        const up = pct > 0;
                        return {
                            text: (pct > 0 ? '+' : '') + pct.toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' %',
                            arrow: pct === 0 ? 'fa-minus' : up ? 'fa-arrow-up' : 'fa-arrow-down',
                            cls: pct === 0 ? 'text-slate-400' : up ? 'text-rose-600' : 'text-emerald-600'
                        };
                    };

                    const fuelDelta = deltaOf(this.pilotFuelCost, this.pilotFuelCostPrev);
                    const maintDelta = deltaOf(this.pilotMaintenanceCost, this.pilotMaintenanceCostPrev);
                    const totalDelta = deltaOf(this.pilotTotalCost, this.pilotTotalCostPrev);
                    let consoDelta = null;
                    if (consoKpi && consoKpi.pct != null) {
                        const pct = consoKpi.pct;
                        consoDelta = {
                            text: (pct > 0 ? '+' : '') + pct.toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' %',
                            arrow: pct === 0 ? 'fa-minus' : pct > 0 ? 'fa-arrow-up' : 'fa-arrow-down',
                            cls: pct === 0 ? 'text-slate-400' : pct > 0 ? 'text-rose-600' : 'text-emerald-600'
                        };
                    }

                    return [
                        { key: 'vehicles', label: 'Véhicules', icon: 'fa-car', color: 'indigo', value: String(total), sub: total > 0 ? 'dans le parc' : 'aucun véhicule', state: total > 0 ? 'normal' : 'attention' },
                        { key: 'availability', label: 'Disponibilité', icon: 'fa-circle-check', color: 'emerald', value: availRate + ' %', sub: avail + ' prêts / ' + total, state: availRate >= 80 ? 'normal' : availRate >= 50 ? 'attention' : 'critical' },
                        { key: 'immobilized', label: 'Immobilisés', icon: 'fa-truck-pickup', color: 'rose', value: String(immob), sub: immob > 0 ? 'en maintenance' : 'aucun', state: immob === 0 ? 'normal' : immob > 3 ? 'critical' : 'attention' },
                        { key: 'fuel', label: 'Coût carburant', icon: 'fa-gas-pump', color: 'amber', value: this.fmtPrice(this.pilotFuelCost), sub: 'FCFA · ' + this.pilotFuelLogs.length + ' plein(s)', state: 'normal', delta: fuelDelta },
                        { key: 'total', label: 'Coût total', icon: 'fa-money-bill-wave', color: 'indigo', value: this.fmtPrice(this.pilotTotalCost), sub: 'FCFA · carburant+entretien+sinistres', state: 'normal', delta: totalDelta },
                        { key: 'maintenance', label: 'Maintenance', icon: 'fa-wrench', color: 'violet', value: this.fmtPrice(this.pilotMaintenanceCost), sub: 'FCFA · ' + this.pilotMaintenances.length + ' opération(s)', state: 'normal', delta: maintDelta },
                        { key: 'consumption', label: 'Conso moyenne', icon: 'fa-gauge-high', color: 'sky', value: conso != null ? conso.toLocaleString('fr-FR', { maximumFractionDigits: 1 }) : '—', sub: 'L/100km', state: 'normal', delta: consoDelta },
                        { key: 'overdue', label: 'Maintenance en retard', icon: 'fa-clock', color: 'rose', value: String(overdue), sub: overdue > 0 ? 'à traiter' : 'à jour', state: overdue === 0 ? 'normal' : overdue > 3 ? 'critical' : 'attention' },
                        { key: 'compliance', label: 'Conformité', icon: 'fa-file-shield', color: 'emerald', value: compliance.rate != null ? compliance.rate + ' %' : '—', sub: compliance.total > 0 ? compliance.valid + '/' + compliance.total + ' docs valides' : 'docs non renseignés', state: compliance.rate == null ? 'attention' : compliance.rate >= 90 ? 'normal' : compliance.rate >= 70 ? 'attention' : 'critical' }
                    ];
                },

                // ===== CENTRE DE PILOTAGE — GRAPHIQUES (Phase 7.6) =====

                // Agrège une série (somme) par jour ou par mois selon la période.
                // Labels courts en français : 'JJ/MM' (jour) ou 'Jan 2026' (mois).
                pilotGroupSeries(items, dateField, valueField, granularity) {
                    const monthNames = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
                    const map = {};
                    items.forEach(it => {
                        const d = new Date(it[dateField]);
                        if (isNaN(d.getTime())) return;
                        let key, label;
                        if (granularity === 'day') {
                            key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
                            label = String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
                        } else {
                            key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
                            label = monthNames[d.getMonth()] + ' ' + d.getFullYear();
                        }
                        map[key] = map[key] || { label, total: 0 };
                        map[key].total += parseFloat(it[valueField]) || 0;
                    });
                    const keys = Object.keys(map).sort();
                    return { labels: keys.map(k => map[k].label), data: keys.map(k => map[k].total) };
                },

                // Évolution des coûts de carburant : journalière pour Aujourd'hui /
                // 7 jours, mensuelle sinon. Repli sur les séries serveur si besoin.
                get pilotCostSeries() {
                    const gran = (this.pilotPeriod === 'today' || this.pilotPeriod === '7d') ? 'day' : 'month';
                    const local = this.pilotGroupSeries(this.pilotFuelLogs, 'date', 'cost', gran);
                    if (local.labels.length) return local;
                    const s = this.pilotFuelStats && this.pilotFuelStats.charts && this.pilotFuelStats.charts.costByMonth;
                    return (s && s.labels && s.labels.length) ? s : null;
                },

                // Évolution de la consommation : série serveur calculée à partir des
                // kilométrages réels (seule source fiable) — null si indisponible.
                get pilotConsumptionSeries() {
                    const s = this.pilotFuelStats && this.pilotFuelStats.charts && this.pilotFuelStats.charts.consumptionByMonth;
                    return (s && s.labels && s.labels.length) ? s : null;
                },

                // Répartition des coûts de la période (carburant / maintenance / sinistres).
                get pilotCostSplit() {
                    return [
                        { label: 'Carburant', value: this.pilotFuelCost, colorKey: 'amber' },
                        { label: 'Maintenance', value: this.pilotMaintenanceCost, colorKey: 'violet' },
                        { label: 'Sinistres', value: this.pilotAccidentCost, colorKey: 'rose' }
                    ].filter(s => s.value > 0);
                },

                // Disponibilité de la flotte à l'instant T.
                get pilotAvailabilitySplit() {
                    return [
                        { label: 'Disponibles', value: this.availableVehiclesCount, colorKey: 'emerald' },
                        { label: 'En mission', value: this.bookedVehiclesCount, colorKey: 'blue' },
                        { label: 'En maintenance', value: this.maintenanceVehiclesCount, colorKey: 'amber' }
                    ].filter(s => s.value > 0);
                },

                // État de la maintenance : réalisées / en retard / à venir.
                get pilotMaintenanceSplit() {
                    const today = new Date(); today.setHours(0, 0, 0, 0);
                    let done = 0, upcoming = 0;
                    this.maintenances.forEach(m => {
                        if (m.status === 'EFFECTUÉ') { done++; return; }
                        const d = new Date(m.date);
                        if (isNaN(d.getTime())) return;
                        if (d < today) return; // compté dans « en retard »
                        upcoming++;
                    });
                    return [
                        { label: 'Réalisées', value: done, colorKey: 'emerald' },
                        { label: 'En retard', value: this.pilotOverdueMaintenances().length, colorKey: 'rose' },
                        { label: 'À venir', value: upcoming, colorKey: 'sky' }
                    ].filter(s => s.value > 0);
                },

                // Conformité documents : conformes / proches expiration / critiques / expirés.
                get pilotComplianceSplit() {
                    const c = this.pilotCompliance;
                    return [
                        { label: 'Expirés', value: c.expired, colorKey: 'rose' },
                        { label: 'Critiques ≤ 7 j', value: c.critical, colorKey: 'violet' },
                        { label: 'Proches expiration', value: c.soon, colorKey: 'amber' },
                        { label: 'Conformes', value: c.valid, colorKey: 'emerald' }
                    ].filter(s => s.value > 0);
                },

                // Dessine les 6 graphiques du Centre de pilotage avec la palette du
                // thème actif (chartTheme). Chaque graphique est isolé : une erreur
                // de données n'empêche pas les autres de s'afficher.
                initPilotCharts() {
                    if (this.isSuperAdmin) return;
                    this.loadChartLibrary().then(() => {
                    this.$nextTick(() => {
                        const th = this.chartTheme();
                        const tickStyle = { color: th.text, font: { family: 'Plus Jakarta Sans', size: 10 } };
                        const gridStyle = { color: th.grid };
                        const colorOf = (key) => ({ indigo: th.indigo, blue: th.blue, sky: th.sky, emerald: th.emerald, amber: th.amber, rose: th.rose, violet: th.violet, slate: th.slate }[key] || th.slate);

                        // 1. Évolution des coûts carburant
                        try {
                            const ctx = document.getElementById('pilotCostChart');
                            if (ctx) {
                                if (this.pilotChartCost) this._chartRaw(this.pilotChartCost).destroy();
                                const s = this.pilotCostSeries;
                                if (s && s.labels.length) {
                                    this.pilotChartCost = new Chart(ctx, {
                                        type: 'bar',
                                        data: { labels: s.labels, datasets: [{ label: 'Coût (FCFA)', data: s.data, backgroundColor: th.indigo, borderRadius: 6 }] },
                                        options: {
                                            responsive: true, maintainAspectRatio: false,
                                            plugins: { legend: { display: false } },
                                            scales: {
                                                x: { ticks: tickStyle, grid: { display: false } },
                                                y: { ticks: tickStyle, grid: gridStyle }
                                            }
                                        }
                                    });
                                    this._chartRaw(this.pilotChartCost).update();
                                } else {
                                    this.pilotChartCost = null;
                                }
                            }
                        } catch (e) { console.error('Erreur graphique Coût Carburant (pilotage):', e); }

                        // 2. Évolution de la consommation
                        try {
                            const ctx = document.getElementById('pilotConsumptionChart');
                            if (ctx) {
                                if (this.pilotChartConsumption) this._chartRaw(this.pilotChartConsumption).destroy();
                                const s = this.pilotConsumptionSeries;
                                if (s && s.labels.length) {
                                    this.pilotChartConsumption = new Chart(ctx, {
                                        type: 'line',
                                        data: {
                                            labels: s.labels,
                                            datasets: [{
                                                label: 'Conso (L/100km)',
                                                data: s.data,
                                                borderColor: th.sky,
                                                backgroundColor: this.hexToRgba(th.sky, .15),
                                                fill: true, tension: .35, pointRadius: 3
                                            }]
                                        },
                                        options: {
                                            responsive: true, maintainAspectRatio: false,
                                            plugins: { legend: { display: false } },
                                            scales: {
                                                x: { ticks: tickStyle, grid: { display: false } },
                                                y: { ticks: tickStyle, grid: gridStyle }
                                            }
                                        }
                                    });
                                    this._chartRaw(this.pilotChartConsumption).update();
                                } else {
                                    this.pilotChartConsumption = null;
                                }
                            }
                        } catch (e) { console.error('Erreur graphique Consommation (pilotage):', e); }

                        // Helper commun pour les graphiques en anneau (donut).
                        const doughnut = (canvasId, refName, split) => {
                            const ctx = document.getElementById(canvasId);
                            if (!ctx) return;
                            if (this[refName]) this._chartRaw(this[refName]).destroy();
                            if (!split.length) { this[refName] = null; return; }
                            this[refName] = new Chart(ctx, {
                                type: 'doughnut',
                                data: {
                                    labels: split.map(s => s.label),
                                    datasets: [{
                                        data: split.map(s => s.value),
                                        backgroundColor: split.map(s => colorOf(s.colorKey)),
                                        borderWidth: 2,
                                        borderColor: th.dark ? '#111a2b' : '#ffffff'
                                    }]
                                },
                                options: {
                                    responsive: true, maintainAspectRatio: false,
                                    cutout: '62%',
                                    plugins: {
                                        legend: { position: 'bottom', labels: { color: th.text, font: { family: 'Plus Jakarta Sans', size: 10 }, boxWidth: 10, padding: 8 } }
                                    }
                                }
                            });
                            this._chartRaw(this[refName]).update();
                        };

                        // 3. Répartition des coûts
                        try {
                            doughnut('pilotCostSplitChart', 'pilotChartCostSplit', this.pilotCostSplit);
                        } catch (e) { console.error('Erreur graphique Répartition coûts (pilotage):', e); }

                        // 4. Disponibilité de la flotte
                        try {
                            doughnut('pilotAvailabilityChart', 'pilotChartAvailability', this.pilotAvailabilitySplit);
                        } catch (e) { console.error('Erreur graphique Disponibilité (pilotage):', e); }

                        // 5. État de la maintenance
                        try {
                            doughnut('pilotMaintenanceChart', 'pilotChartMaintenance', this.pilotMaintenanceSplit);
                        } catch (e) { console.error('Erreur graphique Maintenance (pilotage):', e); }

                        // 6. Conformité des documents
                        try {
                            doughnut('pilotComplianceChart', 'pilotChartCompliance', this.pilotComplianceSplit);
                        } catch (e) { console.error('Erreur graphique Conformité (pilotage):', e); }
                    });
                    }).catch((e) => console.error('Chart.js indisponible, graphiques pilotage désactivés:', e.message));
                },

                // Recharge les données + stats du Centre de pilotage (bouton Actualiser).
                // loadAllData() déclenche déjà loadPilotFuelStats() en parallèle.
                async refreshPilot() {
                    await this.loadAllData();
                },

                // Recharge les 7 ressources depuis l'API en parallèle
                async loadAllData() {
                    this.isLoadingData = true;
                    this.apiConnectionError = '';
                    try {
                        const [vehicles, drivers, reservations, maintenances, incidents, accidents, fuelLogs, salesData] = await Promise.all([
                            this.apiFetch('/api/vehicles'),
                            this.apiFetch('/api/drivers'),
                            this.apiFetch('/api/reservations'),
                            this.apiFetch('/api/maintenances'),
                            this.apiFetch('/api/incidents'),
                            this.apiFetch('/api/accidents'),
                            this.apiFetch('/api/fuel-logs'),
                            this.apiFetch('/api/vehicle-sales?pageSize=200')
                        ]);
                        this.vehicles = vehicles || [];
                        this.drivers = drivers || [];
                        this.reservations = reservations || [];
                        this.maintenances = maintenances || [];
                        this.incidents = incidents || [];
                        this.accidents = accidents || [];
                        this.fuelLogs = fuelLogs || [];
                        this.sales = (salesData && salesData.items) || [];
                        this.salesTotal = (salesData && salesData.total) || 0;
                        // Les stats officielles sont chargées avant le rendu des graphiques.
                        await Promise.all([this.loadFuelStats(), this.loadDashboardFuelStats(), this.loadPilotFuelStats()]);
                        console.log('[CHART-DIAG] loadAllData (reponses API)', {
                            vehicles: { count: vehicles.length, premier: vehicles[0] ? { status: vehicles[0].status, mileage: vehicles[0].mileage } : null },
                            drivers: { count: drivers.length },
                            reservations: { count: reservations.length },
                            maintenances: { count: maintenances.length, premier: maintenances[0] ? { type: maintenances[0].type, date: maintenances[0].date, cost: maintenances[0].cost } : null },
                            incidents: { count: incidents.length, premier: incidents[0] ? { priority: incidents[0].priority, date: incidents[0].date } : null },
                            accidents: { count: accidents.length, premier: accidents[0] ? { status: accidents[0].status, date: accidents[0].date } : null },
                            fuelLogs: { count: fuelLogs.length, premier: fuelLogs[0] ? { date: fuelLogs[0].date, cost: fuelLogs[0].cost, liters: fuelLogs[0].liters, vehicle: fuelLogs[0].vehicle } : null }
                        });
                        if (this.mainTab === 'dashboard') this.initCharts();
                    } catch (e) {
                        console.error(e);
                        this.apiConnectionError = e.message || 'Impossible de charger les données depuis le serveur.';
                    } finally {
                        this.isLoadingData = false;
                    }
                },

                // Restaure la session à partir d'un token JWT sauvegardé (persiste la connexion entre visites)
                async restoreSession() {
                    const token = localStorage.getItem(this.SESSION_KEY);
                    if (!token) return;
                    this.authToken = token;
                    try {
                        const data = await this.apiFetch('/api/auth/me');
                        this.currentUser = data.user;
                        if (this.isSuperAdmin) {
                            await this.loadOrganizations();
                            await this.loadSuperAdminStats();
                        } else {
                            await this.loadAllData();
                            await this.loadPaymentHistory();
                            setTimeout(() => this.initCharts(), 150);
                        }
                    } catch (e) {
                        // Token invalide/expiré : on efface la session
                        this.authToken = null;
                        this.currentUser = null;
                        localStorage.removeItem(this.SESSION_KEY);
                    }
                },

                resetAllData() {
                    if (!confirm('Recharger les données depuis le serveur ? Toute modification locale non enregistrée sera perdue.')) return;
                    this.loadAllData();
                },

                // ===== STATISTIQUES CARBURANT (source officielle /api/fuel-logs/stats) =====

                // Charge les stats de l'onglet Carburant pour la période choisie.
                async loadFuelStats() {
                    if (this.isSuperAdmin) return;
                    this.fuelStatsLoading = true;
                    this.fuelStatsError = '';
                    try {
                        this.fuelStats = await this.apiFetch('/api/fuel-logs/stats?period=' + encodeURIComponent(this.fuelStatsPeriod));
                    } catch (e) {
                        if (e && e.status === 403) return; // compte sans organisation (ex. SUPERADMIN)
                        this.fuelStatsError = (e && e.message) || 'Impossible de charger les statistiques carburant.';
                    } finally {
                        this.fuelStatsLoading = false;
                    }
                },

                // Période alignée sur dashboardPeriod (ALL/MONTH/QUARTER/YEAR) pour les
                // graphiques du tableau de bord. Le backend gère today/week/month/prevMonth/year/custom.
                dashboardStatsQuery() {
                    const now = new Date();
                    const pad = n => String(n).padStart(2, '0');
                    const fmt = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
                    const today = fmt(now);
                    if (this.dashboardPeriod === 'MONTH') return 'period=month';
                    if (this.dashboardPeriod === 'YEAR') return 'period=year';
                    if (this.dashboardPeriod === 'QUARTER') {
                        const q = Math.floor(now.getMonth() / 3);
                        return 'period=custom&from=' + now.getFullYear() + '-' + pad(q * 3 + 1) + '-01&to=' + today;
                    }
                    return 'period=custom&from=2000-01-01&to=' + today; // Toutes les périodes
                },

                // Charge les stats alignées sur la période du tableau de bord (graphiques).
                async loadDashboardFuelStats() {
                    if (this.isSuperAdmin) return;
                    this.dashboardFuelStatsLoading = true;
                    try {
                        this.dashboardFuelStats = await this.apiFetch('/api/fuel-logs/stats?' + this.dashboardStatsQuery());
                    } catch (e) {
                        // On conserve l'ancien jeu de données ; les graphiques retombent
                        // sur l'agrégation locale en attendant le prochain chargement.
                    } finally {
                        this.dashboardFuelStatsLoading = false;
                    }
                },

                // ===== CENTRE DE PILOTAGE — STATS CARBURANT (Phase 7.6) =====

                // Traduit pilotPeriod en paramètre de requête /api/fuel-logs/stats.
                pilotStatsQuery() {
                    const now = new Date();
                    const pad = n => String(n).padStart(2, '0');
                    const fmt = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
                    const today = fmt(now);
                    if (this.pilotPeriod === 'today') return 'period=today';
                    if (this.pilotPeriod === '7d') return 'period=week';
                    if (this.pilotPeriod === 'month') return 'period=month';
                    if (this.pilotPeriod === 'year') return 'period=year';
                    if (this.pilotPeriod === 'quarter') {
                        const q = Math.floor(now.getMonth() / 3);
                        return 'period=custom&from=' + now.getFullYear() + '-' + pad(q * 3 + 1) + '-01&to=' + today;
                    }
                    return 'period=month';
                },

                // Charge les stats carburant alignées sur pilotPeriod (Centre de pilotage).
                // Réutilise le même endpoint que l'onglet Carburant (aucune nouvelle API).
                async loadPilotFuelStats() {
                    if (this.isSuperAdmin) return;
                    this.pilotFuelStatsLoading = true;
                    try {
                        this.pilotFuelStats = await this.apiFetch('/api/fuel-logs/stats?' + this.pilotStatsQuery());
                    } catch (e) {
                        if (e && e.status === 403) return; // compte sans organisation (ex. SUPERADMIN)
                        this.pilotFuelStats = null; // écran vide propre si l'endpoint échoue
                    } finally {
                        this.pilotFuelStatsLoading = false;
                    }
                },
                // ===== FIN STATISTIQUES CARBURANT =====

                // ===== FIN CONNEXION À L'API =====

                // ===== ONGLET DOCUMENTATION (module documents / Phase 8) =====
                // Liste paginée et statistiques fournies par /api/documents.
                // Le statut (OK / SOON / EXPIRED / UNKNOWN) et le nombre de jours
                // restants sont dérivés côté backend : le frontend les affiche
                // sans dupliquer la logique métier.
                documentQueryString() {
                    const f = this.documentFilters;
                    const p = this.documentPagination;
                    const parts = ['page=' + p.page, 'pageSize=' + p.pageSize];
                    if (f.search) parts.push('search=' + encodeURIComponent(f.search));
                    if (f.documentType) parts.push('documentType=' + encodeURIComponent(f.documentType));
                    if (f.vehicleId) parts.push('vehicleId=' + encodeURIComponent(f.vehicleId));
                    if (f.driverId) parts.push('driverId=' + encodeURIComponent(f.driverId));
                    if (f.status) parts.push('status=' + encodeURIComponent(f.status));
                    if (f.expiryFrom) parts.push('expiryFrom=' + encodeURIComponent(f.expiryFrom));
                    if (f.expiryTo) parts.push('expiryTo=' + encodeURIComponent(f.expiryTo));
                    return parts.join('&');
                },

                async loadDocuments() {
                    if (this.isSuperAdmin) return;
                    this.documentsLoading = true;
                    this.documentsError = '';
                    try {
                        const data = await this.apiFetch('/api/documents?' + this.documentQueryString());
                        this.documents = (data && data.items) || [];
                        this.documentPagination = {
                            page: (data && data.page) || 1,
                            pageSize: (data && data.pageSize) || this.documentPagination.pageSize,
                            total: (data && data.total) || 0
                        };
                    } catch (e) {
                        if (e && e.status === 403) return;
                        this.documentsError = (e && e.message) || 'Impossible de charger les documents.';
                        this.documents = [];
                    } finally {
                        this.documentsLoading = false;
                    }
                },

                // Compteurs réels (Total / Valides / ≤ 7 j / Bientôt / Expirés /
                // Sans date) : les valeurs proviennent du champ "total" renvoyé
                // par l'API /api/documents (filtre par statut inclus) — aucun
                // calcul local. Le statut CRITICAL (≤ 7 j) est distinct de SOON.
                async loadDocumentStats() {
                    if (this.isSuperAdmin) return;
                    this.documentsStatsLoading = true;
                    try {
                        const totalOf = (qs) => this.apiFetch('/api/documents?' + qs).then(d => (d && d.total) || 0);
                        const [total, ok, critical, soon, expired, unknown] = await Promise.all([
                            totalOf('page=1&pageSize=1'),
                            totalOf('page=1&pageSize=1&status=OK'),
                            totalOf('page=1&pageSize=1&status=CRITICAL'),
                            totalOf('page=1&pageSize=1&status=SOON'),
                            totalOf('page=1&pageSize=1&status=EXPIRED'),
                            totalOf('page=1&pageSize=1&status=UNKNOWN')
                        ]);
                        this.documentStats = { total, ok, critical, soon, expired, unknown };
                    } catch (e) {
                        if (e && e.status === 403) return;
                        this.documentStats = { total: 0, ok: 0, critical: 0, soon: 0, expired: 0, unknown: 0 };
                    } finally {
                        this.documentsStatsLoading = false;
                    }
                },

                // Nombre de documents réellement urgents (expirés ou ≤ 7 jours) :
                // utilisé pour le badge de navigation et la cloche de notifications.
                get documentUrgentCount() {
                    return (this.documentStats.expired || 0) + (this.documentStats.critical || 0);
                },

                // Total des documents à renouveler (expirés, critiques et bientôt).
                get documentRenewalCount() {
                    return (this.documentStats.expired || 0) + (this.documentStats.critical || 0) + (this.documentStats.soon || 0);
                },

                // Résumé textuel des urgences pour la cloche de notifications.
                get documentRenewalSummary() {
                    const parts = [];
                    if (this.documentStats.expired) parts.push(this.documentStats.expired + ' expiré(s)');
                    if (this.documentStats.critical) parts.push(this.documentStats.critical + ' urgent(s) ≤ 7 j');
                    if (this.documentStats.soon) parts.push(this.documentStats.soon + ' sous 30 j');
                    return parts.length ? parts.join(' · ') : 'Aucun document à renouveler';
                },

                // Liste « Documents à renouveler » (EXPIRED / CRITICAL / SOON),
                // chargée depuis /api/documents (sort=expiry, pageSize max) puis
                // triée par urgence : expirés d'abord, puis échéance croissante.
                // Aucun doublon : chaque document n'apparaît qu'une fois.
                async loadDocumentsToRenew() {
                    if (this.isSuperAdmin) return;
                    this.documentsRenewLoading = true;
                    try {
                        const fetchStatus = (status) => this.apiFetch('/api/documents?page=1&pageSize=200&sort=expiry&status=' + status)
                            .then(d => (d && d.items) || []);
                        const [expired, critical, soon] = await Promise.all([
                            fetchStatus('EXPIRED'),
                            fetchStatus('CRITICAL'),
                            fetchStatus('SOON')
                        ]);
                        const priority = { EXPIRED: 0, CRITICAL: 1, SOON: 2 };
                        const merged = [...expired, ...critical, ...soon].sort((a, b) => {
                            const pa = priority[a.status] ?? 9;
                            const pb = priority[b.status] ?? 9;
                            if (pa !== pb) return pa - pb;
                            return (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999);
                        });
                        this.documentsToRenew = merged;
                    } catch (e) {
                        if (e && e.status === 403) return;
                        this.documentsToRenew = [];
                    } finally {
                        this.documentsRenewLoading = false;
                    }
                },

                // Compteur cliqué → filtre automatique du tableau par statut
                // ('' pour le total = aucun filtre).
                setDocumentStatusFilter(status) {
                    this.documentFilters.status = status || '';
                    this.documentPagination.page = 1;
                    this.loadDocuments();
                },

                // Ouverture de l'onglet Documentation sur la liste à renouveler.
                goToDocumentRenewal() {
                    this.documentFilters.status = '';
                    this.documentPagination.page = 1;
                    this.mainTab = 'documents';
                    this.refreshDocuments();
                },

                refreshDocuments() {
                    return Promise.all([this.loadDocuments(), this.loadDocumentStats(), this.loadDocumentsToRenew()]);
                },

                applyDocumentFilters() {
                    this.documentPagination.page = 1;
                    this.loadDocuments();
                },

                resetDocumentFilters() {
                    this.documentFilters = { search: '', documentType: '', vehicleId: '', driverId: '', status: '', expiryFrom: '', expiryTo: '' };
                    this.documentPagination.page = 1;
                    this.loadDocuments();
                },

                goToDocumentPage(target) {
                    const bounded = Math.min(Math.max(1, target), this.documentTotalPages);
                    if (bounded === this.documentPagination.page) return;
                    this.documentPagination.page = bounded;
                    this.loadDocuments();
                },

                get documentTotalPages() {
                    return Math.max(1, Math.ceil(this.documentPagination.total / this.documentPagination.pageSize));
                },

                get documentPageInfo() {
                    const { page, pageSize, total } = this.documentPagination;
                    if (!total) return '0 document';
                    const start = (page - 1) * pageSize + 1;
                    const end = Math.min(page * pageSize, total);
                    return start + '–' + end + ' sur ' + total + (total > 1 ? ' documents' : ' document');
                },

                documentOwnerLabel(d) {
                    if (d.vehicleId) {
                        const v = this.vehicles.find(x => x.id === d.vehicleId);
                        return v ? v.brand + ' ' + v.model + ' — ' + v.plate : 'Véhicule #' + d.vehicleId;
                    }
                    if (d.driverId) {
                        const dr = this.drivers.find(x => x.id === d.driverId);
                        return dr ? dr.name : 'Conducteur #' + d.driverId;
                    }
                    return '—';
                },

                documentOwnerKind(d) {
                    return d.vehicleId ? 'Véhicule' : 'Conducteur';
                },

                documentStatusMeta(d) {
                    if (d.status === 'OK') return { badge: 'badge-green', label: 'Valide' };
                    if (d.status === 'CRITICAL') return { badge: 'badge-violet', label: 'Urgent ≤ 7 j' };
                    if (d.status === 'SOON') return { badge: 'badge-amber', label: 'Expire bientôt' };
                    if (d.status === 'EXPIRED') return { badge: 'badge-red', label: 'Expiré' };
                    return { badge: 'badge-slate', label: 'Sans date' };
                },

                documentStatusDetail(d) {
                    if (!d || d.status === 'UNKNOWN' || d.daysLeft == null) return '';
                    if (d.status === 'EXPIRED') return 'Expiré depuis ' + Math.abs(d.daysLeft) + ' j';
                    if (d.status === 'CRITICAL') return 'Urgent : expire dans ' + d.daysLeft + ' j';
                    if (d.status === 'SOON') return 'Expire dans ' + d.daysLeft + ' j';
                    return 'Valide (' + d.daysLeft + ' j restants)';
                },

                documentTypeIcon(type) {
                    const icons = {
                        'Assurance': 'fa-shield-halved',
                        'Carte Grise': 'fa-id-card',
                        'Contrôle Technique': 'fa-clipboard-check',
                        'Permis': 'fa-id-card-clip',
                        'Vignette': 'fa-tag',
                        'Autorisation': 'fa-file-circle-check',
                        'Autre': 'fa-file-lines'
                    };
                    return icons[type] || 'fa-file-lines';
                },

                async deleteDocument(doc) {
                    if (!this.canManageFleet || !doc) return;
                    if (this.documentDeleting) return; // anti double-clic
                    if (!confirm('Supprimer le document « ' + (doc.documentNumber || doc.documentType) + ' » ? Cette action est irréversible.')) return;
                    this.documentDeleting = true;
                    try {
                        await this.apiFetch('/api/documents/' + doc.id, { method: 'DELETE' });
                        await this.refreshDocuments();
                        alert('Document supprimé avec succès.');
                    } catch (e) {
                        alert(this.documentApiError(e, 'supprimer le document'));
                    } finally {
                        this.documentDeleting = false;
                    }
                },

                resetDocumentForm() {
                    this.documentForm = { vehicleId: '', driverId: '', documentType: '', documentNumber: '', issueDate: '', expiryDate: '', notes: '' };
                    this.documentOwnerType = 'vehicle';
                    this.documentFormError = '';
                    this.documentFormInitial = null;
                },

                // ===== PIÈCE JOINTE DOCUMENT (Phase Documentation — Commit 5) =====
                resetDocumentFileState() {
                    this.documentFileSelected = null;
                    this.documentFileProgress = 0;
                    this.documentFileError = '';
                    this.documentFileUploading = false;
                },

                onDocumentFileSelect(event) {
                    this.documentFileError = '';
                    this.documentFileSelected = null;
                    const input = event && event.target;
                    const file = input && input.files && input.files[0];
                    if (!file) return;
                    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
                    const allowedExt = /\.(pdf|jpe?g|png|webp)$/i.test(file.name);
                    if (!allowedTypes.includes(file.type) || !allowedExt) {
                        this.documentFileError = 'Format non autorisé. Formats acceptés : PDF, JPG, PNG, WEBP (10 Mo max).';
                        if (input) input.value = '';
                        return;
                    }
                    if (file.size > 10 * 1024 * 1024) {
                        this.documentFileError = 'Fichier trop volumineux (10 Mo max).';
                        if (input) input.value = '';
                        return;
                    }
                    this.documentFileSelected = file;
                },

                async uploadDocumentFile(documentId) {
                    if (!this.documentFileSelected || !documentId) return;
                    this.documentFileUploading = true;
                    this.documentFileError = '';
                    this.documentFileProgress = 0;
                    try {
                        const formData = new FormData();
                        formData.append('file', this.documentFileSelected);
                        await new Promise((resolve, reject) => {
                            const xhr = new XMLHttpRequest();
                            xhr.open('POST', this.apiUrl('/api/documents/' + documentId + '/file'));
                            xhr.setRequestHeader('Authorization', 'Bearer ' + this.authToken);
                            xhr.upload.onprogress = (e) => {
                                if (e.lengthComputable) this.documentFileProgress = Math.round((e.loaded / e.total) * 100);
                            };
                            xhr.onload = () => {
                                if (xhr.status >= 200 && xhr.status < 300) {
                                    this.documentFileProgress = 100;
                                    resolve();
                                    return;
                                }
                                let msg = 'Upload échoué (statut ' + xhr.status + ').';
                                try {
                                    const d = JSON.parse(xhr.responseText);
                                    if (d && d.error) msg = d.error;
                                } catch (err) { /* corps non JSON */ }
                                reject(new Error(msg));
                            };
                            xhr.onerror = () => reject(new Error('Erreur réseau pendant l’envoi du fichier.'));
                            xhr.send(formData);
                        });
                    } catch (e) {
                        this.documentFileError = e.message || 'Upload impossible.';
                        throw e;
                    } finally {
                        this.documentFileUploading = false;
                    }
                },

                async fetchDocumentFile(documentId, mode) {
                    if (!this.authToken || !documentId) return;
                    this.documentFileError = '';
                    try {
                        const res = await fetch(this.apiUrl('/api/documents/' + documentId + '/file'), {
                            headers: { 'Authorization': 'Bearer ' + this.authToken },
                        });
                        if (res.status === 404) {
                            this.documentFileError = 'Pièce jointe introuvable (document sans fichier ?).';
                            return;
                        }
                        if (!res.ok) {
                            let msg = 'Téléchargement impossible (statut ' + res.status + ').';
                            try {
                                const d = await res.json();
                                if (d && d.error) msg = d.error;
                            } catch (err) { /* pas de corps JSON */ }
                            throw new Error(msg);
                        }
                        const blob = await res.blob();
                        const url = URL.createObjectURL(blob);
                        const link = document.createElement('a');
                        link.href = url;
                        link.target = '_blank';
                        link.rel = 'noopener noreferrer';
                        const name = (this.documentSelected && this.documentSelected.id === documentId && this.documentSelected.fileName) || '';
                        if (mode === 'download' && name) link.download = name;
                        document.body.appendChild(link);
                        link.click();
                        document.body.removeChild(link);
                        setTimeout(() => URL.revokeObjectURL(url), 10000);
                    } catch (e) {
                        this.documentFileError = e.message || 'Impossible de récupérer le fichier.';
                    }
                },

                viewDocumentFile(doc) {
                    this.fetchDocumentFile(doc && doc.id, 'view');
                },

                downloadDocumentFile(doc) {
                    this.fetchDocumentFile(doc && doc.id, 'download');
                },

                async deleteDocumentFile(doc) {
                    if (!doc || !doc.id) return;
                    if (!confirm('Supprimer la pièce jointe de ce document ?')) return;
                    this.documentFileError = '';
                    try {
                        await this.apiFetch('/api/documents/' + doc.id + '/file', { method: 'DELETE' });
                        const fresh = (this.documents || []).find((d) => d.id === doc.id);
                        if (this.documentSelected && this.documentSelected.id === doc.id) {
                            this.documentSelected = fresh || Object.assign({}, doc, { fileName: null, mimeType: null, fileSize: null, filePath: null });
                        }
                        await this.refreshDocuments();
                        alert('Pièce jointe supprimée.');
                    } catch (e) {
                        this.documentFileError = this.documentApiError(e, 'supprimer la pièce jointe');
                    }
                },

                openDocumentModal(mode, document) {
                    if (!['create', 'edit', 'view'].includes(mode)) return;
                    if (this.documentFormSaving) return; // ouverture bloquée pendant l'enregistrement
                    this.resetDocumentForm();
                    this.documentModalMode = mode;
                    this.documentSelected = document || null;
                    if (mode !== 'create' && this.documentSelected) {
                        const d = this.documentSelected;
                        this.documentOwnerType = d.vehicleId ? 'vehicle' : 'driver';
                        this.documentForm = {
                            vehicleId: d.vehicleId ? String(d.vehicleId) : '',
                            driverId: d.driverId ? String(d.driverId) : '',
                            documentType: d.documentType || '',
                            documentNumber: d.documentNumber || '',
                            issueDate: d.issueDate || '',
                            expiryDate: d.expiryDate || '',
                            notes: d.notes || ''
                        };
                    }
                    this.documentFormInitial = JSON.parse(JSON.stringify(this.documentForm));
                    this.resetDocumentFileState();
                    this.showDocumentModal = true;
                },

                closeDocumentModal() {
                    if (this.documentFormSaving) return; // fermeture bloquée pendant la sauvegarde
                    if (this.documentModalMode !== 'view' && this.documentFormDirty) {
                        if (!confirm('Des modifications non enregistrées vont être perdues. Fermer quand même ?')) return;
                    }
                    this.showDocumentModal = false;
                    this.resetDocumentFileState();
                },

                setDocumentOwnerType(type) {
                    if (!['vehicle', 'driver'].includes(type)) return;
                    this.documentOwnerType = type;
                    this.documentForm.vehicleId = '';
                    this.documentForm.driverId = '';
                },

                get documentFormDirty() {
                    if (!this.documentFormInitial) return false;
                    return JSON.stringify(this.documentForm) !== JSON.stringify(this.documentFormInitial);
                },

                get documentStatusPreview() {
                    const s = this.getDocumentStatus(this.documentForm.expiryDate);
                    const icons = { OK: '🟢', CRITICAL: '🟣', SOON: '🟠', EXPIRED: '🔴', UNKNOWN: '⚪' };
                    return { ...s, icon: icons[s.status] || '⚪' };
                },

                get documentStatusDetailText() {
                    const s = this.getDocumentStatus(this.documentForm.expiryDate);
                    if (!s || s.status === 'UNKNOWN' || s.daysLeft == null) return '';
                    if (s.status === 'EXPIRED') return 'Expiré depuis ' + Math.abs(s.daysLeft) + ' j';
                    if (s.status === 'CRITICAL') return 'Urgent : expire dans ' + s.daysLeft + ' j';
                    if (s.status === 'SOON') return 'Expire dans ' + s.daysLeft + ' j';
                    return 'Valide (' + s.daysLeft + ' j restants)';
                },

                validateDocumentForm() {
                    const f = this.documentForm;
                    if (!f.documentType) return 'Le type de document est obligatoire.';
                    const hasVehicle = !!f.vehicleId;
                    const hasDriver = !!f.driverId;
                    if (hasVehicle && hasDriver) return 'Un document doit être rattaché soit à un véhicule, soit à un conducteur, mais pas aux deux.';
                    if (!hasVehicle && !hasDriver) return 'Le document doit être rattaché à un véhicule ou à un conducteur.';
                    if (f.documentNumber && f.documentNumber.length > 100) return 'Le numéro du document est trop long (100 caractères max).';
                    if (f.notes && f.notes.length > 4000) return 'Les notes sont trop longues (4000 caractères max).';
                    if (f.issueDate && f.expiryDate && f.expiryDate < f.issueDate) return 'La date d\'expiration ne peut pas être antérieure à la date d\'émission.';
                    return '';
                },

                documentApiError(e, action) {
                    const status = e && e.status;
                    const msg = e && e.message;
                    if (status === 400) return 'Données invalides : ' + (msg || 'la requête a été rejetée par le serveur.');
                    if (status === 401) return 'Session expirée. Reconnectez-vous puis réessayez.';
                    if (status === 403) return 'Vous n\'avez pas les droits nécessaires pour ' + action + '.';
                    if (status === 404) return 'Document introuvable. Il a peut-être été supprimé entre-temps.';
                    if (status === 409) return 'Conflit avec les données existantes : ' + (msg || 'réessayez.');
                    if (status === 500) return 'Erreur serveur. Réessayez dans quelques instants.';
                    return (msg || ('Impossible de ' + action + '.'));
                },

                async saveDocumentSubmit() {
                    if (this.documentFormSaving) return; // anti double-clic
                    this.documentFormError = '';
                    const validation = this.validateDocumentForm();
                    if (validation) {
                        this.documentFormError = validation;
                        return;
                    }
                    this.documentFormSaving = true;
                    const f = this.documentForm;
                    const payload = {
                        vehicleId: f.vehicleId ? Number(f.vehicleId) : null,
                        driverId: f.driverId ? Number(f.driverId) : null,
                        documentType: f.documentType.trim(),
                        documentNumber: f.documentNumber.trim(),
                        issueDate: f.issueDate || null,
                        expiryDate: f.expiryDate || null,
                        notes: f.notes.trim()
                    };
                    try {
                        let savedDocId = null;
                        if (this.documentModalMode === 'edit' && this.documentSelected) {
                            await this.apiFetch('/api/documents/' + this.documentSelected.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                            savedDocId = this.documentSelected.id;
                            alert('Document modifié avec succès.');
                        } else {
                            const created = await this.apiFetch('/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                            savedDocId = created && created.id;
                            alert('Document ajouté avec succès.');
                        }
                        if (this.documentFileSelected && savedDocId) {
                            try {
                                await this.uploadDocumentFile(savedDocId);
                            } catch (e) {
                                alert('Document enregistré, mais la pièce jointe n’a pas pu être envoyée : ' + ((e && e.message) || 'erreur inconnue.'));
                            }
                            this.documentFileSelected = null;
                            this.documentFileProgress = 0;
                        }
                        this.showDocumentModal = false;
                        await this.refreshDocuments();
                    } catch (e) {
                        this.documentFormError = this.documentApiError(e, 'enregistrer le document');
                    } finally {
                        this.documentFormSaving = false;
                    }
                },
                // ===== FIN ONGLET DOCUMENTATION =====

                // Garantit que Chart.js est chargé avant de créer les graphiques.
                // Si le script CDN n'est pas encore disponible, le charge dynamiquement
                // avec repli automatique sur un second CDN (cas de CDN bloqué/injoignable).
                loadChartLibrary() {
                    if (typeof window.Chart !== 'undefined') return Promise.resolve(window.Chart);
                    if (this._chartLibPromise) return this._chartLibPromise;
                    const fallbackUrls = [
                        'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
                        'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js'
                    ];
                    const loadNext = (idx) => {
                        if (typeof window.Chart !== 'undefined') return Promise.resolve(window.Chart);
                        if (idx >= fallbackUrls.length) return Promise.reject(new Error('Chart.js indisponible (CDN injoignables).'));
                        return new Promise((resolve, reject) => {
                            const s = document.createElement('script');
                            s.src = fallbackUrls[idx];
                            s.async = true;
                            s.onload = () => loadNext(idx + 1).then(resolve).catch(reject);
                            s.onerror = () => loadNext(idx + 1).then(resolve).catch(reject);
                            document.head.appendChild(s);
                        });
                    };
                    const promise = loadNext(0);
                    this._chartLibPromise = promise;
                    promise.catch(() => { this._chartLibPromise = null; });
                    return promise;
                },

                // DIAGNOSTIC : log détaillé pour chaque graphique (avant/après création).
                chartDiag(name, step, ctx, labels, data, extra) {
                    const nonNuls = (Array.isArray(data) ? data : []).filter(v => Number(v) !== 0).length;
                    console.log('[CHART-DIAG] ' + name + ' [' + step + ']', {
                        canvas: ctx ? {
                            existe: true,
                            largeur: ctx.clientWidth,
                            hauteur: ctx.clientHeight,
                            parentHauteur: ctx.parentElement ? ctx.parentElement.clientHeight : null
                        } : { existe: false },
                        labels: Array.isArray(labels) ? labels : null,
                        labelsNonVides: Array.isArray(labels) && labels.length > 0,
                        data: Array.isArray(data) ? data : null,
                        dataCount: Array.isArray(data) ? data.length : 0,
                        donneesNonNulles: nonNuls,
                        ...(extra || {})
                    });
                },

                _chartRaw(inst) {
                    return (typeof window.Alpine !== 'undefined' && typeof window.Alpine.raw === 'function') ? window.Alpine.raw(inst) : inst;
                },

                // Palette de couleurs des graphiques selon le thème actif (clair/sombre).
                // Les graphiques sont recréés à chaque changement de thème via
                // addEventListenerThemeChange → initCharts().
                chartTheme() {
                    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
                    return {
                        dark,
                        text: dark ? '#9aa8c1' : '#64748b',
                        grid: dark ? 'rgba(148, 163, 184, .14)' : 'rgba(100, 116, 139, .18)',
                        indigo: dark ? '#818cf8' : '#6366f1',
                        blue: dark ? '#60a5fa' : '#3b82f6',
                        sky: dark ? '#38bdf8' : '#0ea5e9',
                        emerald: dark ? '#34d399' : '#10b981',
                        amber: dark ? '#fbbf24' : '#f59e0b',
                        rose: dark ? '#fb7185' : '#ef4444',
                        orange: dark ? '#fb923c' : '#f97316',
                        violet: dark ? '#a78bfa' : '#8b5cf6',
                        slate: dark ? '#94a3b8' : '#64748b'
                    };
                },

                hexToRgba(hex, alpha) {
                    const n = parseInt(String(hex).replace('#', ''), 16);
                    if (Number.isNaN(n) || String(hex).replace('#', '').length !== 6) return hex;
                    return 'rgba(' + (n >> 16 & 255) + ', ' + (n >> 8 & 255) + ', ' + (n & 255) + ', ' + alpha + ')';
                },

                initCharts() {
                    this.loadChartLibrary().then(() => {
                    this.$nextTick(() => {
                        this._diagInitCount = (this._diagInitCount || 0) + 1;
                        console.log('[CHART-DIAG] initCharts appel n°' + this._diagInitCount, {
                            mainTab: this.mainTab,
                            dashboardPeriod: this.dashboardPeriod,
                            chartJSCharge: typeof window.Chart,
                            sources: {
                                vehicles: this.vehicles.length,
                                fuelLogs: this.fuelLogs.length,
                                maintenances: this.maintenances.length,
                                incidents: this.incidents.length,
                                accidents: this.accidents.length
                            },
                            instancesExistantes: {
                                fuel: !!this.chartFuel, status: !!this.chartStatus, topVehicles: !!this.chartTopVehicles,
                                oilChanges: !!this.chartOilChanges, incidents: !!this.chartIncidents, accidents: !!this.chartAccidents,
                                maintenance: !!this.chartMaintenance, fuelConsumers: !!this.chartFuelConsumers
                            }
                        });
                        // Palette du thème actif (clair/sombre) : appliquée à tous les graphiques.
                        const th = this.chartTheme();
                        // Chaque graphique est isolé dans son propre try/catch :
                        // si l'un d'eux rencontre un problème de données, les autres
                        // continuent quand même de s'afficher normalement.

                        // 1. Graphique Carburant (source officielle /stats quand disponible)
                        try {
                        const ctxFuel = document.getElementById('fuelChart');
                        if (ctxFuel) {
                            if (this.chartFuel) this._chartRaw(this.chartFuel).destroy();
                            const statsCharts = this.dashboardFuelStats && this.dashboardFuelStats.charts;
                            const fuelMonthly = statsCharts && statsCharts.costByMonth && statsCharts.costByMonth.labels && statsCharts.costByMonth.labels.length
                                ? statsCharts.costByMonth
                                : this.fuelExpensesByMonth;
                            this.chartDiag('1.Carburant', 'avant-creation', ctxFuel, fuelMonthly.labels, fuelMonthly.data, { sources: { stats: !!this.dashboardFuelStats, fuelLogs: this.fuelLogs.length, periodFuelLogs: this.periodFuelLogs.length, dashboardPeriod: this.dashboardPeriod } });
                            this.chartFuel = new Chart(ctxFuel, {
                                type: 'bar',
                                data: {
                                    labels: fuelMonthly.labels,
                                    datasets: [{
                                        label: 'Dépenses Carburant (FCFA)',
                                        data: fuelMonthly.data,
                                        backgroundColor: th.indigo,
                                        borderRadius: 8
                                    }]
                                },
                                options: { 
                                    responsive: true, 
                                    maintainAspectRatio: false,
                                    plugins: { legend: { labels: { color: th.text, font: { family: 'Plus Jakarta Sans' } } } },
                                    scales: {
                                        x: { ticks: { color: th.text }, grid: { color: th.grid } },
                                        y: { ticks: { color: th.text }, grid: { color: th.grid } }
                                    }
                                }
                            });
                            this._chartRaw(this.chartFuel).update();
                            this.chartDiag('1.Carburant', 'apres-creation', ctxFuel, fuelMonthly.labels, fuelMonthly.data, { chartExecute: true, updateAppele: true });
                        }
                        } catch (e) { console.error('Erreur graphique Carburant:', e); }

                        // 2. Graphique Statut Véhicules
                        try {
                        const ctxStatus = document.getElementById('statusChart');
                        if (ctxStatus) {
                            if (this.chartStatus) this._chartRaw(this.chartStatus).destroy();
                            this.chartDiag('2.Statut', 'avant-creation', ctxStatus, ['Disponibles', 'En Mission', 'En Maintenance'], [this.availableVehiclesCount, this.bookedVehiclesCount, this.maintenanceVehiclesCount], { sources: { vehicles: this.vehicles.length, available: this.availableVehiclesCount, booked: this.bookedVehiclesCount, maintenance: this.maintenanceVehiclesCount } });
                            this.chartStatus = new Chart(ctxStatus, {
                                type: 'doughnut',
                                data: {
                                    labels: ['Disponibles', 'En Mission', 'En Maintenance'],
                                    datasets: [{
                                        data: [this.availableVehiclesCount, this.bookedVehiclesCount, this.maintenanceVehiclesCount],
                                        backgroundColor: [th.emerald, th.blue, th.amber],
                                        borderWidth: 0
                                    }]
                                },
                                options: { 
                                    responsive: true, 
                                    maintainAspectRatio: false,
                                    plugins: { legend: { position: 'bottom', labels: { color: th.text, font: { family: 'Plus Jakarta Sans' } } } }
                                }
                            });
                            this._chartRaw(this.chartStatus).update();
                            this.chartDiag('2.Statut', 'apres-creation', ctxStatus, ['Disponibles', 'En Mission', 'En Maintenance'], [this.availableVehiclesCount, this.bookedVehiclesCount, this.maintenanceVehiclesCount], { chartExecute: true, updateAppele: true });
                        }
                        } catch (e) { console.error('Erreur graphique Statut Véhicules:', e); }

                        // 3. Graphique Top Véhicules les plus parcourus
                        try {
                        const ctxTopVehicles = document.getElementById('topVehiclesChart');
                        if (ctxTopVehicles) {
                            if (this.chartTopVehicles) this._chartRaw(this.chartTopVehicles).destroy();
                            const topData = this.topVehiclesData;
                            this.chartDiag('3.TopVehicules', 'avant-creation', ctxTopVehicles, topData.labels, topData.data, { sources: { vehicles: this.vehicles.length } });
                            this.chartTopVehicles = new Chart(ctxTopVehicles, {
                                type: 'bar',
                                data: {
                                    labels: topData.labels,
                                    datasets: [{
                                        label: 'Kilométrage (km)',
                                        data: topData.data,
                                        backgroundColor: th.sky,
                                        borderRadius: 6
                                    }]
                                },
                                options: {
                                    indexAxis: 'y',
                                    responsive: true,
                                    maintainAspectRatio: false,
                                    plugins: { legend: { display: false } },
                                    scales: {
                                        x: { ticks: { color: th.text }, grid: { color: th.grid } },
                                        y: { ticks: { color: th.text, font: { size: 10 } }, grid: { display: false } }
                                    }
                                }
                            });
                            this._chartRaw(this.chartTopVehicles).update();
                            this.chartDiag('3.TopVehicules', 'apres-creation', ctxTopVehicles, topData.labels, topData.data, { chartExecute: true, updateAppele: true });
                        }
                        } catch (e) { console.error('Erreur graphique Top Véhicules:', e); }

                        // 4. Graphique Nombre de Vidanges Effectuées
                        try {
                        const ctxOilChanges = document.getElementById('oilChangesChart');
                        if (ctxOilChanges) {
                            if (this.chartOilChanges) this._chartRaw(this.chartOilChanges).destroy();
                            const oilMonthly = this.oilChangesByMonth;
                            this.chartDiag('4.Vidanges', 'avant-creation', ctxOilChanges, oilMonthly.labels, oilMonthly.data, { sources: { maintenances: this.maintenances.length, periodMaintenances: this.periodMaintenances.length, dashboardPeriod: this.dashboardPeriod } });
                            this.chartOilChanges = new Chart(ctxOilChanges, {
                                type: 'line',
                                data: {
                                    labels: oilMonthly.labels,
                                    datasets: [{
                                        label: 'Vidanges Effectuées',
                                        data: oilMonthly.data,
                                        borderColor: th.amber,
                                        backgroundColor: this.hexToRgba(th.amber, .15),
                                        fill: true,
                                        tension: 0.3
                                    }]
                                },
                                options: {
                                    responsive: true,
                                    maintainAspectRatio: false,
                                    plugins: { legend: { display: false } },
                                    scales: {
                                        x: { ticks: { color: th.text }, grid: { color: th.grid } },
                                        y: { ticks: { color: th.text, stepSize: 1, precision: 0 }, grid: { color: th.grid } }
                                    }
                                }
                            });
                            this._chartRaw(this.chartOilChanges).update();
                            this.chartDiag('4.Vidanges', 'apres-creation', ctxOilChanges, oilMonthly.labels, oilMonthly.data, { chartExecute: true, updateAppele: true });
                        }
                        } catch (e) { console.error('Erreur graphique Vidanges:', e); }

                        // 5. Graphique Signalements par Priorité
                        try {
                        const ctxIncidents = document.getElementById('incidentsChart');
                        if (ctxIncidents) {
                            if (this.chartIncidents) this._chartRaw(this.chartIncidents).destroy();
                            this.chartDiag('5.Incidents', 'avant-creation', ctxIncidents, ['Haute Priorité', 'Moyenne Priorité', 'Basse Priorité'], this.incidentsPriorityCount, { sources: { incidents: this.incidents.length, periodIncidents: this.periodIncidents.length, dashboardPeriod: this.dashboardPeriod } });
                            this.chartIncidents = new Chart(ctxIncidents, {
                                type: 'doughnut',
                                data: {
                                    labels: ['Haute Priorité', 'Moyenne Priorité', 'Basse Priorité'],
                                    datasets: [{
                                        data: this.incidentsPriorityCount,
                                        backgroundColor: [th.rose, th.amber, th.slate],
                                        borderWidth: 0
                                    }]
                                },
                                options: { 
                                    responsive: true, 
                                    maintainAspectRatio: false,
                                    plugins: { legend: { position: 'bottom', labels: { color: th.text, font: { family: 'Plus Jakarta Sans' } } } }
                                }
                            });
                            this._chartRaw(this.chartIncidents).update();
                            this.chartDiag('5.Incidents', 'apres-creation', ctxIncidents, ['Haute Priorité', 'Moyenne Priorité', 'Basse Priorité'], this.incidentsPriorityCount, { chartExecute: true, updateAppele: true });
                        }
                        } catch (e) { console.error('Erreur graphique Signalements:', e); }

                        // 6. Graphique Traitement des Accidents
                        try {
                        const ctxAccidents = document.getElementById('accidentsChart');
                        if (ctxAccidents) {
                            if (this.chartAccidents) this._chartRaw(this.chartAccidents).destroy();
                            this.chartDiag('6.Accidents', 'avant-creation', ctxAccidents, ['Déclaré', 'Assurance', 'Réparé'], this.accidentsStatusCount, { sources: { accidents: this.accidents.length, periodAccidents: this.periodAccidents.length, dashboardPeriod: this.dashboardPeriod } });
                            this.chartAccidents = new Chart(ctxAccidents, {
                                type: 'bar',
                                data: {
                                    labels: ['Déclaré', 'Assurance', 'Réparé'],
                                    datasets: [{
                                        label: 'Dossiers Sinistres',
                                        data: this.accidentsStatusCount,
                                        backgroundColor: [th.rose, th.amber, th.emerald],
                                        borderRadius: 6
                                    }]
                                },
                                options: { 
                                    responsive: true, 
                                    maintainAspectRatio: false,
                                    plugins: { legend: { display: false } },
                                    scales: {
                                        x: { ticks: { color: th.text }, grid: { display: false } },
                                        y: { ticks: { color: th.text, stepSize: 1 }, grid: { color: th.grid } }
                                    }
                                }
                            });
                            this._chartRaw(this.chartAccidents).update();
                            this.chartDiag('6.Accidents', 'apres-creation', ctxAccidents, ['Déclaré', 'Assurance', 'Réparé'], this.accidentsStatusCount, { chartExecute: true, updateAppele: true });
                        }
                        } catch (e) { console.error('Erreur graphique Accidents:', e); }

                        // 7. Graphique Coût des Entretiens
                        try {
                        const ctxMaintenance = document.getElementById('maintenanceChart');
                        if (ctxMaintenance) {
                            if (this.chartMaintenance) this._chartRaw(this.chartMaintenance).destroy();
                            const maintMonthly = this.maintenanceCostByMonth;
                            this.chartDiag('7.Maintenance', 'avant-creation', ctxMaintenance, maintMonthly.labels, maintMonthly.data, { sources: { maintenances: this.maintenances.length, periodMaintenances: this.periodMaintenances.length, dashboardPeriod: this.dashboardPeriod } });
                            this.chartMaintenance = new Chart(ctxMaintenance, {
                                type: 'line',
                                data: {
                                    labels: maintMonthly.labels,
                                    datasets: [{
                                        label: 'Coût Entretiens (FCFA)',
                                        data: maintMonthly.data,
                                        borderColor: th.indigo,
                                        backgroundColor: this.hexToRgba(th.indigo, .15),
                                        fill: true,
                                        tension: 0.4
                                    }]
                                },
                                options: { 
                                    responsive: true, 
                                    maintainAspectRatio: false,
                                    plugins: { legend: { labels: { color: th.text, font: { family: 'Plus Jakarta Sans' } } } },
                                    scales: {
                                        x: { ticks: { color: th.text }, grid: { color: th.grid } },
                                        y: { ticks: { color: th.text }, grid: { color: th.grid } }
                                    }
                                }
                            });
                            this._chartRaw(this.chartMaintenance).update();
                            this.chartDiag('7.Maintenance', 'apres-creation', ctxMaintenance, maintMonthly.labels, maintMonthly.data, { chartExecute: true, updateAppele: true });
                        }
                        } catch (e) { console.error('Erreur graphique Coût Entretiens:', e); }

                        // 8. Graphique Top Véhicules Consommateurs de Carburant (source /stats)
                        try {
                        const ctxFuelConsumers = document.getElementById('fuelConsumersChart');
                        if (ctxFuelConsumers) {
                            if (this.chartFuelConsumers) this._chartRaw(this.chartFuelConsumers).destroy();
                            const statsCharts = this.dashboardFuelStats && this.dashboardFuelStats.charts;
                            const topConsumers = statsCharts && statsCharts.topConsumers && statsCharts.topConsumers.labels && statsCharts.topConsumers.labels.length
                                ? statsCharts.topConsumers
                                : this.topFuelConsumersData;
                            this.chartDiag('8.Consommateurs', 'avant-creation', ctxFuelConsumers, topConsumers.labels, topConsumers.data, { sources: { stats: !!this.dashboardFuelStats, fuelLogs: this.fuelLogs.length, periodFuelLogs: this.periodFuelLogs.length, dashboardPeriod: this.dashboardPeriod } });
                            this.chartFuelConsumers = new Chart(ctxFuelConsumers, {
                                type: 'bar',
                                data: {
                                    labels: topConsumers.labels,
                                    datasets: [{
                                        label: 'Litres Consommés',
                                        data: topConsumers.data,
                                        backgroundColor: th.orange,
                                        borderRadius: 6
                                    }]
                                },
                                options: {
                                    indexAxis: 'y',
                                    responsive: true,
                                    maintainAspectRatio: false,
                                    plugins: { legend: { display: false } },
                                    scales: {
                                        x: { ticks: { color: th.text }, grid: { color: th.grid } },
                                        y: { ticks: { color: th.text, font: { size: 10 } }, grid: { display: false } }
                                    }
                                }
                            });
                            this._chartRaw(this.chartFuelConsumers).update();
                            this.chartDiag('8.Consommateurs', 'apres-creation', ctxFuelConsumers, topConsumers.labels, topConsumers.data, { chartExecute: true, updateAppele: true });
                        }
                        } catch (e) { console.error('Erreur graphique Top Consommateurs Carburant:', e); }

                        // Graphiques du Centre de pilotage (Phase 7.6) : redessinés
                        // avec les graphiques du tableau de bord (thème, rechargement
                        // des données, retour sur l'onglet dashboard).
                        if (this.mainTab === 'dashboard') {
                            this.initPilotCharts();
                        }

                    });
                    }).catch((e) => console.error('Chart.js indisponible, graphiques désactivés:', e.message));
                },

                // Graphiques du dashboard plateforme (SuperAdmin)
                initSuperAdminCharts() {
                    this.loadChartLibrary().then(() => {
                    this.$nextTick(() => {
                        const stats = this.superadminStats;
                        if (!stats || !stats.charts) return;
                        const th = this.chartTheme();
                        const tickStyle = { color: th.text, font: { family: 'Plus Jakarta Sans', size: 10 } };
                        const gridStyle = { color: th.grid };
                        this._diagSuperInitCount = (this._diagSuperInitCount || 0) + 1;
                        console.log('[CHART-DIAG] initSuperAdminCharts appel n°' + this._diagSuperInitCount, {
                            chartJSCharge: typeof window.Chart,
                            statsPresentes: !!stats,
                            orgGrowth: { labels: stats.charts.orgGrowth.labels, data: stats.charts.orgGrowth.data },
                            mrr: { labels: stats.charts.mrrByMonth.labels, data: stats.charts.mrrByMonth.data },
                            fleetByOrg: { labels: stats.charts.fleetByOrg.labels, data: stats.charts.fleetByOrg.data },
                            instancesExistantes: { orgGrowth: !!this.chartOrgGrowth, mrr: !!this.chartMrr, fleetByOrg: !!this.chartFleetByOrg }
                        });

                        // 1. Croissance des clients (12 derniers mois)
                        try {
                            const ctxGrowth = document.getElementById('orgGrowthChart');
                            if (ctxGrowth) {
                                if (this.chartOrgGrowth) this._chartRaw(this.chartOrgGrowth).destroy();
                                this.chartDiag('S1.Croissance', 'avant-creation', ctxGrowth, stats.charts.orgGrowth.labels, stats.charts.orgGrowth.data);
                                this.chartOrgGrowth = new Chart(ctxGrowth, {
                                    type: 'line',
                                    data: {
                                        labels: stats.charts.orgGrowth.labels,
                                        datasets: [{
                                            label: 'Clients créés',
                                            data: stats.charts.orgGrowth.data,
                                            borderColor: th.indigo,
                                            backgroundColor: this.hexToRgba(th.indigo, .15),
                                            fill: true,
                                            tension: 0.35,
                                            pointRadius: 3,
                                            pointBackgroundColor: th.indigo
                                        }]
                                    },
                                    options: {
                                        responsive: true,
                                        maintainAspectRatio: false,
                                        plugins: { legend: { display: false } },
                                        scales: {
                                            x: { ticks: tickStyle, grid: { display: false } },
                                            y: { ticks: tickStyle, grid: gridStyle, beginAtZero: true }
                                        }
                                    }
                                });
                                this._chartRaw(this.chartOrgGrowth).update();
                                this.chartDiag('S1.Croissance', 'apres-creation', ctxGrowth, stats.charts.orgGrowth.labels, stats.charts.orgGrowth.data, { chartExecute: true, updateAppele: true });
                            }
                        } catch (e) { console.error('Erreur graphique Croissance clients:', e); }

                        // 2. Évolution du MRR
                        try {
                            const ctxMrr = document.getElementById('mrrChart');
                            if (ctxMrr) {
                                if (this.chartMrr) this._chartRaw(this.chartMrr).destroy();
                                this.chartDiag('S2.MRR', 'avant-creation', ctxMrr, stats.charts.mrrByMonth.labels, stats.charts.mrrByMonth.data);
                                this.chartMrr = new Chart(ctxMrr, {
                                    type: 'line',
                                    data: {
                                        labels: stats.charts.mrrByMonth.labels,
                                        datasets: [{
                                            label: 'MRR (FCFA)',
                                            data: stats.charts.mrrByMonth.data,
                                            borderColor: th.emerald,
                                            backgroundColor: this.hexToRgba(th.emerald, .15),
                                            fill: true,
                                            tension: 0.35,
                                            pointRadius: 3,
                                            pointBackgroundColor: th.emerald
                                        }]
                                    },
                                    options: {
                                        responsive: true,
                                        maintainAspectRatio: false,
                                        plugins: { legend: { display: false } },
                                        scales: {
                                            x: { ticks: tickStyle, grid: { display: false } },
                                            y: {
                                                ticks: { ...tickStyle, callback: (v) => (Number(v) >= 1000 ? Math.round(v / 1000) + 'k' : v) },
                                                grid: gridStyle
                                            }
                                        }
                                    }
                                });
                                this._chartRaw(this.chartMrr).update();
                                this.chartDiag('S2.MRR', 'apres-creation', ctxMrr, stats.charts.mrrByMonth.labels, stats.charts.mrrByMonth.data, { chartExecute: true, updateAppele: true });
                            }
                        } catch (e) { console.error('Erreur graphique MRR:', e); }

                        // 3. Flotte par client
                        try {
                            const ctxFleet = document.getElementById('fleetByOrgChart');
                            if (ctxFleet) {
                                if (this.chartFleetByOrg) this._chartRaw(this.chartFleetByOrg).destroy();
                                this.chartDiag('S3.Flotte', 'avant-creation', ctxFleet, stats.charts.fleetByOrg.labels, stats.charts.fleetByOrg.data);
                                this.chartFleetByOrg = new Chart(ctxFleet, {
                                    type: 'bar',
                                    data: {
                                        labels: stats.charts.fleetByOrg.labels,
                                        datasets: [{
                                            label: 'Véhicules',
                                            data: stats.charts.fleetByOrg.data,
                                            backgroundColor: th.violet,
                                            borderRadius: 8
                                        }]
                                    },
                                    options: {
                                        indexAxis: 'y',
                                        responsive: true,
                                        maintainAspectRatio: false,
                                        plugins: { legend: { display: false } },
                                        scales: {
                                            x: { ticks: tickStyle, grid: gridStyle, beginAtZero: true },
                                            y: { ticks: tickStyle, grid: { display: false } }
                                        }
                                    }
                                });
                                this._chartRaw(this.chartFleetByOrg).update();
                                this.chartDiag('S3.Flotte', 'apres-creation', ctxFleet, stats.charts.fleetByOrg.labels, stats.charts.fleetByOrg.data, { chartExecute: true, updateAppele: true });
                            }
                        } catch (e) { console.error('Erreur graphique Flotte par client:', e); }
                    });
                    }).catch((e) => console.error('Chart.js indisponible, graphiques désactivés:', e.message));
                },

                // ===== EXPORT DE RAPPORTS (PDF / EXCEL) =====
                exportReportPDF() {
                    try {
                        const { jsPDF } = window.jspdf;
                        const doc = new jsPDF();
                        const genDate = new Date().toLocaleDateString('fr-FR');
                        const totalAccidentCost = this.accidents.reduce((s, a) => s + (a.costEstimate || 0), 0);

                        doc.setFontSize(16);
                        doc.setTextColor(30, 30, 30);
                        doc.text('Asadiya Flotte PRO — Rapport de Flotte', 14, 18);
                        doc.setFontSize(9);
                        doc.setTextColor(120);
                        doc.text('Généré le ' + genDate, 14, 24);

                        // Résumé des coûts
                        doc.setFontSize(12);
                        doc.setTextColor(30, 30, 30);
                        doc.text('Résumé des Coûts', 14, 34);
                        doc.autoTable({
                            startY: 38,
                            head: [['Catégorie', 'Montant (FCFA)']],
                            body: [
                                ['Carburant', this.totalFuelCost.toLocaleString()],
                                ['Entretiens', this.totalMaintenanceCost.toLocaleString()],
                                ['Sinistres (estimation)', totalAccidentCost.toLocaleString()],
                            ],
                            theme: 'grid',
                            headStyles: { fillColor: [99, 102, 241] },
                            styles: { fontSize: 9 }
                        });

                        // Kilométrage par véhicule
                        let y = doc.lastAutoTable.finalY + 10;
                        doc.setFontSize(12);
                        doc.text('Kilométrage par Véhicule', 14, y);
                        doc.autoTable({
                            startY: y + 4,
                            head: [['Véhicule', 'Immatriculation', 'Kilométrage (km)', 'Statut']],
                            body: this.vehicles.map(v => [`${v.brand} ${v.model}`, v.plate, v.mileage.toLocaleString(), v.status]),
                            theme: 'grid',
                            headStyles: { fillColor: [99, 102, 241] },
                            styles: { fontSize: 9 }
                        });

                        // Sinistres & accidents
                        y = doc.lastAutoTable.finalY + 10;
                        doc.setFontSize(12);
                        doc.text('Sinistres & Accidents', 14, y);
                        doc.autoTable({
                            startY: y + 4,
                            head: [['Véhicule', 'Date', 'Lieu', 'Estimation (FCFA)', 'Statut']],
                            body: this.accidents.map(a => [a.vehicle, a.date, a.location, a.costEstimate.toLocaleString(), a.status]),
                            theme: 'grid',
                            headStyles: { fillColor: [244, 63, 94] },
                            styles: { fontSize: 9 }
                        });

                        doc.save('rapport-flotte-' + genDate.replace(/\//g, '-') + '.pdf');
                    } catch (e) {
                        console.error(e);
                        alert('Impossible de générer le PDF (bibliothèque non chargée). Vérifiez votre connexion internet.');
                    }
                },

                exportReportExcel() {
                    try {
                        if (typeof XLSX === 'undefined') throw new Error('XLSX non chargé');
                        const wb = XLSX.utils.book_new();
                        const totalAccidentCost = this.accidents.reduce((s, a) => s + (a.costEstimate || 0), 0);

                        const wsCosts = XLSX.utils.aoa_to_sheet([
                            ['Catégorie', 'Montant (FCFA)'],
                            ['Carburant', this.totalFuelCost],
                            ['Entretiens', this.totalMaintenanceCost],
                            ['Sinistres (estimation)', totalAccidentCost]
                        ]);
                        XLSX.utils.book_append_sheet(wb, wsCosts, 'Coûts');

                        const wsMileage = XLSX.utils.aoa_to_sheet([
                            ['Véhicule', 'Immatriculation', 'Kilométrage (km)', 'Statut'],
                            ...this.vehicles.map(v => [`${v.brand} ${v.model}`, v.plate, v.mileage, v.status])
                        ]);
                        XLSX.utils.book_append_sheet(wb, wsMileage, 'Kilométrage');

                        const wsAccidents = XLSX.utils.aoa_to_sheet([
                            ['Véhicule', 'Date', 'Lieu', 'Dégâts', 'Estimation (FCFA)', 'Statut'],
                            ...this.accidents.map(a => [a.vehicle, a.date, a.location, a.damage, a.costEstimate, a.status])
                        ]);
                        XLSX.utils.book_append_sheet(wb, wsAccidents, 'Sinistres');

                        const wsFuel = XLSX.utils.aoa_to_sheet([
                            ['Véhicule', 'Date', 'Litres', 'Coût (FCFA)', 'Kilométrage'],
                            ...this.fuelLogs.map(f => [f.vehicle, f.date, f.liters, f.cost, f.mileage])
                        ]);
                        XLSX.utils.book_append_sheet(wb, wsFuel, 'Carburant');

                        const wsMaintenance = XLSX.utils.aoa_to_sheet([
                            ['Véhicule', 'Type', 'Date', 'Coût (FCFA)', 'Statut', 'Prestataire'],
                            ...this.maintenances.map(m => [m.vehicle, m.type, m.date, m.cost, m.status, m.provider])
                        ]);
                        XLSX.utils.book_append_sheet(wb, wsMaintenance, 'Entretiens');

                        XLSX.writeFile(wb, 'rapport-flotte-' + new Date().toISOString().split('T')[0] + '.xlsx');
                    } catch (e) {
                        console.error(e);
                        alert('Impossible de générer le fichier Excel (bibliothèque non chargée). Vérifiez votre connexion internet.');
                    }
                },
                // ===== FIN EXPORT DE RAPPORTS =====

                // Enregistrer l'exécution d'une vidange
                openOilChangeModal(veh) {
                    this.oilChangeData.vehicleId = veh.id;
                    this.oilChangeData.currentKm = veh.mileage;
                    this.oilChangeData.cost = 50000;
                    this.oilChangeData.provider = 'Garage agréé';
                    this.showOilChangeModal = true;
                },

                async submitOilChange() {
                    const veh = this.vehicles.find(v => v.id == this.oilChangeData.vehicleId);
                    if (!veh) return;

                    const newKm = parseInt(this.oilChangeData.currentKm) || veh.mileage;
                    const nextOilChangeKm = newKm + this.oilChangeInterval;

                    try {
                        // 1. Enregistre l'entretien de vidange
                        const maint = await this.apiFetch('/api/maintenances', {
                            method: 'POST',
                            body: JSON.stringify({
                                vehicleId: veh.id,
                                vehicle: `${veh.brand} ${veh.model} (${veh.plate})`,
                                type: 'Vidange Moteur & Remplacement Filtres',
                                cost: parseInt(this.oilChangeData.cost) || 50000,
                                date: new Date().toISOString().split('T')[0],
                                status: 'EFFECTUÉ',
                                provider: this.oilChangeData.provider || 'Garage agréé'
                            })
                        });
                        this.maintenances.unshift(maint);

                        // 2. Met à jour le véhicule (kilométrage + prochaine échéance)
                        const updatedVeh = await this.apiFetch('/api/vehicles/' + veh.id, {
                            method: 'PUT',
                            body: JSON.stringify({ ...veh, mileage: newKm, lastOilChangeKm: newKm, nextOilChangeKm })
                        });
                        Object.assign(veh, updatedVeh);

                        this.showOilChangeModal = false;
                        alert(`Vidange enregistrée avec succès pour ${veh.brand} ${veh.model}. Prochaine vidange fixée à ${veh.nextOilChangeKm.toLocaleString()} km !`);
                        if (this.mainTab === 'dashboard') this.initCharts();
                    } catch (e) {
                        alert('Erreur : ' + (e.message || 'impossible d\'enregistrer la vidange.'));
                    }
                },

                // Gestion des carburants
                openFuelModal(veh = null) {
                    this.newFuelLog = {
                        vehicleId: veh ? veh.id : '',
                        date: new Date().toISOString().split('T')[0],
                        liters: '',
                        cost: '',
                        mileage: veh ? veh.mileage : ''
                    };
                    this.showFuelModal = true;
                },

                async addFuelLogSubmit() {
                    const veh = this.vehicles.find(v => v.id == this.newFuelLog.vehicleId);
                    if (!veh || !this.newFuelLog.date || !this.newFuelLog.liters || !this.newFuelLog.cost || !this.newFuelLog.mileage) {
                        alert('Veuillez remplir tous les champs obligatoires.');
                        return;
                    }
                    const liters = parseFloat(this.newFuelLog.liters);
                    const cost = parseInt(this.newFuelLog.cost);
                    const mileage = parseInt(this.newFuelLog.mileage);

                    try {
                        const created = await this.apiFetch('/api/fuel-logs', {
                            method: 'POST',
                            body: JSON.stringify({
                                vehicleId: veh.id,
                                vehicle: `${veh.brand} ${veh.model}`,
                                date: this.newFuelLog.date,
                                liters, cost, mileage
                            })
                        });
                        this.fuelLogs.unshift(created);

                        // Met à jour le kilométrage du véhicule si le plein est plus récent
                        if (mileage > veh.mileage) {
                            const updatedVeh = await this.apiFetch('/api/vehicles/' + veh.id, {
                                method: 'PUT',
                                body: JSON.stringify({ ...veh, mileage })
                            });
                            Object.assign(veh, updatedVeh);
                        }

                        this.showFuelModal = false;
                        await Promise.all([this.loadFuelStats(), this.loadDashboardFuelStats()]);
                        if (this.mainTab === 'dashboard') this.initCharts();
                    } catch (e) {
                        alert('Erreur : ' + (e.message || 'impossible d\'enregistrer le plein.'));
                    }
                },

                async deleteFuelLog(id) {
                    if (!confirm('Supprimer ce reçu de carburant ?')) return;
                    try {
                        await this.apiFetch('/api/fuel-logs/' + id, { method: 'DELETE' });
                        this.fuelLogs = this.fuelLogs.filter(f => f.id !== id);
                        await Promise.all([this.loadFuelStats(), this.loadDashboardFuelStats()]);
                        if (this.mainTab === 'dashboard') this.initCharts();
                    } catch (e) {
                        alert('Erreur : ' + (e.message || 'suppression impossible.'));
                    }
                },

                // ===== BUDGET CARBURANT MENSUEL (ADMIN / MANAGER uniquement) =====
                openFuelBudgetModal(budget = null) {
                    if (!this.canManageFleet) return;
                    this.editingFuelBudgetId = budget ? budget.id : null;
                    const now = new Date();
                    this.newFuelBudget = {
                        month: budget ? String(budget.month).slice(0, 7) : now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0'),
                        amount: budget ? Math.round(budget.amount) : ''
                    };
                    this.fuelBudgetError = '';
                    this.showFuelBudgetModal = true;
                },

                async saveFuelBudget() {
                    const month = String(this.newFuelBudget.month || '').trim();
                    const amount = parseFloat(this.newFuelBudget.amount);
                    if (!/^\d{4}-\d{2}$/.test(month)) {
                        this.fuelBudgetError = 'Le mois doit être au format AAAA-MM.';
                        return;
                    }
                    if (Number.isNaN(amount) || amount < 0) {
                        this.fuelBudgetError = 'Le montant doit être un nombre positif.';
                        return;
                    }
                    this.fuelBudgetSaving = true;
                    this.fuelBudgetError = '';
                    try {
                        if (this.editingFuelBudgetId) {
                            await this.apiFetch('/api/fuel-logs/budgets/' + this.editingFuelBudgetId, {
                                method: 'PUT',
                                body: JSON.stringify({ amount: Math.round(amount) })
                            });
                        } else {
                            await this.apiFetch('/api/fuel-logs/budgets', {
                                method: 'POST',
                                body: JSON.stringify({ month, amount: Math.round(amount) })
                            });
                        }
                        this.showFuelBudgetModal = false;
                        await Promise.all([this.loadFuelStats(), this.loadDashboardFuelStats()]);
                    } catch (e) {
                        this.fuelBudgetError = (e && e.message) || 'Impossible d\'enregistrer le budget.';
                    } finally {
                        this.fuelBudgetSaving = false;
                    }
                },

                async deleteFuelBudget(id) {
                    if (!this.canManageFleet) return;
                    if (!confirm('Supprimer ce budget mensuel ?')) return;
                    try {
                        await this.apiFetch('/api/fuel-logs/budgets/' + id, { method: 'DELETE' });
                        await Promise.all([this.loadFuelStats(), this.loadDashboardFuelStats()]);
                    } catch (e) {
                        alert('Erreur : ' + (e.message || 'suppression impossible.'));
                    }
                },
                // ===== FIN BUDGET CARBURANT MENSUEL =====

                // Gestion des véhicules
                openVehicleModal(v = null) {
                    if (v) {
                        this.editingVehicleId = v.id;
                        this.newVehicle = {
                            plate: v.plate, brand: v.brand, model: v.model, year: v.year,
                            mileage: v.mileage, lastOilChangeKm: v.lastOilChangeKm, fuel: v.fuel, status: v.status,
                            insuranceExpiry: v.insuranceExpiry || '', registrationExpiry: v.registrationExpiry || '', technicalControlExpiry: v.technicalControlExpiry || '',
                            photo: v.photo || ''
                        };
                    } else {
                        this.editingVehicleId = null;
                        this.newVehicle = { plate: '', brand: '', model: '', year: 2024, mileage: 0, lastOilChangeKm: 0, fuel: 'Essence', status: 'AVAILABLE', insuranceExpiry: '', registrationExpiry: '', technicalControlExpiry: '', photo: '' };
                    }
                    this.showVehicleModal = true;
                },

                async addVehicleSubmit() {
                    if (!this.newVehicle.plate || !this.newVehicle.brand || !this.newVehicle.model) {
                        alert('Veuillez remplir tous les champs obligatoires.');
                        return;
                    }
                    const km = parseInt(this.newVehicle.mileage) || 0;
                    const lastKm = parseInt(this.newVehicle.lastOilChangeKm) || km;
                    const isElectric = this.newVehicle.fuel === 'Électrique';
                    const nextOilChangeKm = isElectric ? 999999 : (lastKm + this.oilChangeInterval);

                    try {
                        if (this.editingVehicleId) {
                            const v = this.vehicles.find(x => x.id === this.editingVehicleId);
                            const payload = { ...v, ...this.newVehicle, mileage: km, lastOilChangeKm: lastKm, nextOilChangeKm };
                            const updated = await this.apiFetch('/api/vehicles/' + this.editingVehicleId, {
                                method: 'PUT',
                                body: JSON.stringify(payload)
                            });
                            if (v) Object.assign(v, updated);
                        } else {
                            const created = await this.apiFetch('/api/vehicles', {
                                method: 'POST',
                                body: JSON.stringify({
                                    ...this.newVehicle,
                                    mileage: km,
                                    lastOilChangeKm: lastKm,
                                    nextOilChangeKm,
                                    driver: 'Non assigné'
                                })
                            });
                            this.vehicles.push(created);
                        }
                        this.showVehicleModal = false;
                        this.editingVehicleId = null;
                        this.newVehicle = { plate: '', brand: '', model: '', year: 2024, mileage: 0, lastOilChangeKm: 0, fuel: 'Essence', status: 'AVAILABLE', insuranceExpiry: '', registrationExpiry: '', technicalControlExpiry: '', photo: '' };
                        if (this.mainTab === 'dashboard') this.initCharts();
                    } catch (e) {
                        alert('Erreur : ' + (e.message || 'impossible d\'enregistrer le véhicule.'));
                    }
                },

                async deleteVehicle(id) {
                    if (!confirm('Voulez-vous vraiment supprimer ce véhicule ?')) return;
                    try {
                        await this.apiFetch('/api/vehicles/' + id, { method: 'DELETE' });
                        this.vehicles = this.vehicles.filter(v => v.id !== id);
                        if (this.mainTab === 'dashboard') this.initCharts();
                    } catch (e) {
                        alert('Erreur : ' + (e.message || 'suppression impossible.'));
                    }
                },

                // ===== VENTES DE VÉHICULES (Phase 7.7 — Commit 3 : frontend) =====
                // Charge la liste des ventes. Le statut et la recherche sont filtrés
                // côté serveur (/api/vehicle-sales) ; prix min/max et marque/modèle le
                // sont côté client (filteredSales) sur le jeu chargé.
                async loadSales() {
                    this.salesLoading = true;
                    this.salesError = '';
                    try {
                        const q = 'pageSize=200&sort=date' +
                            (this.saleFilterStatus && this.saleFilterStatus !== 'ALL' ? '&status=' + encodeURIComponent(this.saleFilterStatus) : '') +
                            (this.saleSearch.trim() ? '&search=' + encodeURIComponent(this.saleSearch.trim()) : '');
                        const data = await this.apiFetch('/api/vehicle-sales?' + q);
                        this.sales = (data && data.items) || [];
                        this.salesTotal = (data && data.total) || 0;
                    } catch (e) {
                        if (e && e.status === 403) { this.salesError = ''; return; }
                        this.salesError = (e && e.message) || 'Impossible de charger les ventes de véhicules.';
                    } finally {
                        this.salesLoading = false;
                    }
                },

                // Véhicule du parc lié à une vente (pour la photo / marque-modèle).
                saleVehicle(s) {
                    return this.vehicles.find(v => v.id === s.vehicleId) || null;
                },

                saleStatusBadge(status) {
                    return {
                        'DRAFT': { cls: 'badge-slate', label: 'Brouillon' },
                        'IN_PROGRESS': { cls: 'badge-amber', label: 'En cours' },
                        'COMPLETED': { cls: 'badge-green', label: 'Vendu' },
                        'CANCELLED': { cls: 'badge-red', label: 'Annulé' }
                    }[status] || { cls: 'badge-slate', label: status || '—' };
                },

                paymentStatusBadge(status) {
                    return {
                        'PENDING': { cls: 'badge-amber', label: 'Paiement en attente' },
                        'PARTIAL': { cls: 'badge-blue', label: 'Paiement partiel' },
                        'PAID': { cls: 'badge-green', label: 'Payé' },
                        'REFUNDED': { cls: 'badge-slate', label: 'Remboursé' }
                    }[status] || { cls: 'badge-slate', label: status || '—' };
                },

                deliveryStatusBadge(status) {
                    return status === 'DELIVERED'
                        ? { cls: 'badge-green', label: 'Livré' }
                        : { cls: 'badge-amber', label: 'Livraison en attente' };
                },

                openSaleDetail(sale) {
                    this.selectedSale = sale;
                    this.showSaleDetailModal = true;
                },

                // Vendeur renseigné sur la vente (instantané serveur) : seul le
                // compte connecté est identifiable côté client (salespersonId).
                saleSellerName(sale) {
                    if (!sale) return '';
                    if (sale.salespersonId != null && this.currentUser && String(sale.salespersonId) === String(this.currentUser.id)) {
                        return this.currentUser.name;
                    }
                    return '';
                },

                // Création (sale = null) ou modification (sale = vente existante).
                openSaleModal(sale = null) {
                    this.saleFormError = '';
                    this.editingSaleId = sale ? sale.id : null;
                    this.saleBeingEdited = sale || null;
                    if (sale) {
                        this.newSale = {
                            vehicleId: sale.vehicleId != null ? String(sale.vehicleId) : '',
                            title: sale.title || '', description: sale.description || '',
                            mileage: sale.mileage != null ? sale.mileage : '',
                            year: sale.year != null ? sale.year : '',
                            buyerType: sale.buyerType || 'EXTERNAL',
                            buyerId: sale.buyerId != null ? String(sale.buyerId) : '',
                            buyerName: sale.buyerName || '', buyerPhone: sale.buyerPhone || '', buyerEmail: sale.buyerEmail || '',
                            buyerAddress: sale.buyerAddress || '', buyerIdCard: sale.buyerIdCard || '',
                            saleDate: sale.saleDate || new Date().toISOString().slice(0, 10),
                            currency: sale.currency || 'XOF',
                            price: sale.price != null ? sale.price : '',
                            tax: Number(sale.tax) || 0, fees: Number(sale.fees) || 0,
                            paymentMethod: sale.paymentMethod || 'CASH',
                            paymentStatus: sale.paymentStatus || 'PENDING',
                            paidAmount: Number(sale.paidAmount) || 0,
                            deliveryStatus: sale.deliveryStatus || 'PENDING',
                            deliveryDate: sale.deliveryDate || '',
                            status: sale.status || 'DRAFT',
                            notes: sale.notes || ''
                        };
                    } else {
                        this.newSale = {
                            vehicleId: '', title: '', description: '', mileage: '', year: '',
                            buyerType: 'EXTERNAL', buyerId: '', buyerName: '', buyerPhone: '', buyerEmail: '', buyerAddress: '', buyerIdCard: '',
                            saleDate: new Date().toISOString().slice(0, 10), currency: 'XOF', price: '', tax: 0, fees: 0,
                            paymentMethod: 'CASH', paymentStatus: 'PENDING', paidAmount: 0, deliveryStatus: 'PENDING', deliveryDate: '',
                            status: 'DRAFT', notes: ''
                        };
                    }
                    this.showSaleModal = true;
                },

                // Pré-remplit kilométrage / année / titre depuis le véhicule choisi.
                onSaleVehicleChange() {
                    const v = this.vehicles.find(x => String(x.id) === String(this.newSale.vehicleId));
                    if (!v) return;
                    this.newSale.mileage = v.mileage;
                    this.newSale.year = v.year;
                    if (!this.newSale.title) this.newSale.title = v.brand + ' ' + v.model + ' — ' + v.plate;
                },

                saleFormTotal() {
                    return (Number(this.newSale.price) || 0) + (Number(this.newSale.tax) || 0) + (Number(this.newSale.fees) || 0);
                },

                resetSaleFilters() {
                    this.saleSearch = '';
                    this.saleFilterStatus = 'ALL';
                    this.salePriceMin = '';
                    this.salePriceMax = '';
                    this.saleBrandModel = '';
                    this.loadSales();
                },

                async addSaleSubmit() {
                    this.saleFormError = '';
                    if (!this.newSale.vehicleId) {
                        this.saleFormError = 'Veuillez sélectionner un véhicule à mettre en vente.';
                        return;
                    }
                    const price = Number(this.newSale.price);
                    if (!price || price <= 0) {
                        this.saleFormError = 'Le prix de vente doit être strictement positif.';
                        return;
                    }
                    if (!this.newSale.saleDate) {
                        this.saleFormError = 'La date de vente est obligatoire.';
                        return;
                    }
                    if (this.newSale.buyerType === 'INTERNAL' && !this.newSale.buyerId) {
                        this.saleFormError = 'Sélectionnez un acheteur interne (conducteur).';
                        return;
                    }
                    if (this.newSale.buyerType === 'EXTERNAL' && !String(this.newSale.buyerName || '').trim()) {
                        this.saleFormError = 'Renseignez le nom de l\'acheteur externe.';
                        return;
                    }
                    const paid = Number(this.newSale.paidAmount) || 0;
                    if (paid > this.saleFormTotal()) {
                        this.saleFormError = 'Le montant déjà payé ne peut pas dépasser le prix total.';
                        return;
                    }
                    this.saleSaving = true;
                    try {
                        const payload = {
                            vehicleId: this.newSale.vehicleId,
                            title: String(this.newSale.title || '').trim() || undefined,
                            description: String(this.newSale.description || '').trim() || undefined,
                            mileage: this.newSale.mileage === '' ? undefined : Number(this.newSale.mileage),
                            year: this.newSale.year === '' ? undefined : Number(this.newSale.year),
                            buyerType: this.newSale.buyerType,
                            buyerName: this.newSale.buyerType === 'EXTERNAL' ? String(this.newSale.buyerName || '').trim() : undefined,
                            buyerPhone: String(this.newSale.buyerPhone || '').trim() || undefined,
                            buyerEmail: String(this.newSale.buyerEmail || '').trim() || undefined,
                            buyerAddress: String(this.newSale.buyerAddress || '').trim() || undefined,
                            buyerIdCard: String(this.newSale.buyerIdCard || '').trim() || undefined,
                            saleDate: this.newSale.saleDate,
                            currency: this.newSale.currency,
                            price,
                            tax: Number(this.newSale.tax) || 0,
                            fees: Number(this.newSale.fees) || 0,
                            paymentMethod: this.newSale.paymentMethod,
                            paymentStatus: this.newSale.paymentStatus,
                            paidAmount: paid,
                            deliveryStatus: this.newSale.deliveryStatus,
                            deliveryDate: this.newSale.deliveryDate || undefined,
                            status: this.newSale.status,
                            notes: String(this.newSale.notes || '').trim() || undefined
                        };
                        if (this.newSale.buyerType === 'INTERNAL') payload.buyerId = this.newSale.buyerId;
                        if (this.editingSaleId) {
                            const updated = await this.apiFetch('/api/vehicle-sales/' + this.editingSaleId, {
                                method: 'PUT',
                                body: JSON.stringify(payload)
                            });
                            const idx = this.sales.findIndex(s => s.id === this.editingSaleId);
                            if (idx !== -1) this.sales[idx] = Object.assign({}, this.sales[idx], updated);
                        } else {
                            await this.apiFetch('/api/vehicle-sales', { method: 'POST', body: JSON.stringify(payload) });
                        }
                        this.showSaleModal = false;
                        this.saleFormError = '';
                        this.editingSaleId = null;
                        this.saleBeingEdited = null;
                        // Le véhicule passe RESERVED/SOLD côté serveur : on resynchronise
                        // le parc et on rafraîchit la liste des ventes (filtres en vigueur).
                        this.loadSales();
                        const refreshed = await this.apiFetch('/api/vehicles');
                        if (Array.isArray(refreshed)) this.vehicles = refreshed;
                    } catch (e) {
                        this.saleFormError = (e && e.message) || (this.editingSaleId ? 'Impossible de modifier la vente.' : 'Impossible de créer la vente.');
                    } finally {
                        this.saleSaving = false;
                    }
                },

                async deleteSale(id) {
                    if (!confirm('Voulez-vous vraiment supprimer cette vente ? Le véhicule lié sera remis en disponibilité.')) return;
                    this.saleDeleting = true;
                    try {
                        await this.apiFetch('/api/vehicle-sales/' + id, { method: 'DELETE' });
                        this.sales = this.sales.filter(s => s.id !== id);
                        this.showSaleDetailModal = false;
                        this.selectedSale = null;
                        const refreshed = await this.apiFetch('/api/vehicles');
                        if (Array.isArray(refreshed)) this.vehicles = refreshed;
                    } catch (e) {
                        alert('Erreur : ' + (e.message || 'suppression impossible.'));
                    } finally {
                        this.saleDeleting = false;
                    }
                },

                // Gestion des conducteurs
                openDriverModal(d = null) {
                    if (d) {
                        this.editingDriverId = d.id;
                        this.newDriver = { name: d.name, email: d.email, phone: d.phone, license: d.license, status: d.status, licenseExpiry: d.licenseExpiry || '', photo: d.photo || '' };
                    } else {
                        this.editingDriverId = null;
                        this.newDriver = { name: '', email: '', phone: '', license: '', status: 'DISPONIBLE', licenseExpiry: '', photo: '' };
                    }
                    this.showDriverModal = true;
                },

                async addDriverSubmit() {
                    if (!this.newDriver.name || !this.newDriver.email) {
                        alert('Veuillez renseigner au moins le nom et l\'email du conducteur.');
                        return;
                    }
                    try {
                        if (this.editingDriverId) {
                            const d = this.drivers.find(x => x.id === this.editingDriverId);
                            const payload = {
                                ...d,
                                name: this.newDriver.name,
                                email: this.newDriver.email,
                                phone: this.newDriver.phone || 'Non renseigné',
                                license: this.newDriver.license || 'Non spécifié',
                                licenseExpiry: this.newDriver.licenseExpiry,
                                photo: this.newDriver.photo
                            };
                            const updated = await this.apiFetch('/api/drivers/' + this.editingDriverId, {
                                method: 'PUT',
                                body: JSON.stringify(payload)
                            });
                            if (d) Object.assign(d, updated);
                        } else {
                            const created = await this.apiFetch('/api/drivers', {
                                method: 'POST',
                                body: JSON.stringify({
                                    name: this.newDriver.name,
                                    email: this.newDriver.email,
                                    phone: this.newDriver.phone || 'Non renseigné',
                                    license: this.newDriver.license || 'Non spécifié',
                                    status: 'DISPONIBLE',
                                    licenseExpiry: this.newDriver.licenseExpiry,
                                    photo: this.newDriver.photo
                                })
                            });
                            this.drivers.push(created);
                        }
                        this.showDriverModal = false;
                        this.editingDriverId = null;
                        this.newDriver = { name: '', email: '', phone: '', license: '', status: 'DISPONIBLE', licenseExpiry: '', photo: '' };
                    } catch (e) {
                        alert('Erreur : ' + (e.message || 'impossible d\'enregistrer le conducteur.'));
                    }
                },

                async deleteDriver(id) {
                    if (!confirm('Voulez-vous vraiment supprimer ce conducteur ?')) return;
                    try {
                        await this.apiFetch('/api/drivers/' + id, { method: 'DELETE' });
                        this.drivers = this.drivers.filter(d => d.id !== id);
                    } catch (e) {
                        alert('Erreur : ' + (e.message || 'suppression impossible.'));
                    }
                },

                // ===== GESTION DES PHOTOS (véhicules & conducteurs) =====
                // Redimensionne et compresse l'image côté client avant stockage (localStorage limité)
                handlePhotoUpload(event, target) {
                    const file = event.target.files[0];
                    if (!file) return;
                    if (!file.type.startsWith('image/')) {
                        alert('Veuillez sélectionner un fichier image (JPG, PNG...).');
                        return;
                    }
                    if (file.size > 8 * 1024 * 1024) {
                        alert('Image trop volumineuse (max 8 Mo).');
                        return;
                    }
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        const img = new Image();
                        img.onload = () => {
                            const maxSize = 320;
                            let { width, height } = img;
                            if (width > height && width > maxSize) {
                                height = Math.round(height * (maxSize / width));
                                width = maxSize;
                            } else if (height > maxSize) {
                                width = Math.round(width * (maxSize / height));
                                height = maxSize;
                            }
                            const canvas = document.createElement('canvas');
                            canvas.width = width;
                            canvas.height = height;
                            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                            const dataUrl = canvas.toDataURL('image/jpeg', 0.75);
                            if (target === 'vehicle') this.newVehicle.photo = dataUrl;
                            if (target === 'driver') this.newDriver.photo = dataUrl;
                        };
                        img.onerror = () => alert('Impossible de lire cette image.');
                        img.src = e.target.result;
                    };
                    reader.readAsDataURL(file);
                },

                removePhoto(target) {
                    if (target === 'vehicle') this.newVehicle.photo = '';
                    if (target === 'driver') this.newDriver.photo = '';
                },
                // ===== FIN GESTION DES PHOTOS =====

                // Planification des entretiens
                openMaintenanceModal(m = null) {
                    if (m) {
                        this.editingMaintenanceId = m.id;
                        this.newMaintenance = { vehicleId: m.vehicleId, type: m.type, cost: m.cost, date: m.date, status: m.status, provider: m.provider };
                    } else {
                        this.editingMaintenanceId = null;
                        this.newMaintenance = { vehicleId: '', type: '', cost: '', date: '', status: 'PLANIFIÉ', provider: '' };
                    }
                    this.showMaintenanceModal = true;
                },

                async addMaintenanceSubmit() {
                    if (!this.newMaintenance.vehicleId || !this.newMaintenance.type || !this.newMaintenance.date) {
                        alert('Veuillez sélectionner un véhicule, saisir le type d\'entretien et la date.');
                        return;
                    }
                    const veh = this.vehicles.find(v => v.id == this.newMaintenance.vehicleId);
                    const status = this.newMaintenance.status || 'PLANIFIÉ';

                    try {
                        if (this.editingMaintenanceId) {
                            const m = this.maintenances.find(x => x.id === this.editingMaintenanceId);
                            const payload = {
                                ...m,
                                vehicleId: veh.id,
                                vehicle: `${veh.brand} ${veh.model} (${veh.plate})`,
                                type: this.newMaintenance.type,
                                cost: parseInt(this.newMaintenance.cost) || 0,
                                date: this.newMaintenance.date,
                                status,
                                provider: this.newMaintenance.provider || 'Garage partenaire'
                            };
                            const updated = await this.apiFetch('/api/maintenances/' + this.editingMaintenanceId, {
                                method: 'PUT',
                                body: JSON.stringify(payload)
                            });
                            if (m) Object.assign(m, updated);
                        } else {
                            const created = await this.apiFetch('/api/maintenances', {
                                method: 'POST',
                                body: JSON.stringify({
                                    vehicleId: veh.id,
                                    vehicle: `${veh.brand} ${veh.model} (${veh.plate})`,
                                    type: this.newMaintenance.type,
                                    cost: parseInt(this.newMaintenance.cost) || 0,
                                    date: this.newMaintenance.date,
                                    status,
                                    provider: this.newMaintenance.provider || 'Garage partenaire'
                                })
                            });
                            this.maintenances.push(created);
                        }

                        if (veh && status === 'URGENT' && veh.status !== 'IN_MAINTENANCE') {
                            const updatedVeh = await this.apiFetch('/api/vehicles/' + veh.id, {
                                method: 'PUT',
                                body: JSON.stringify({ ...veh, status: 'IN_MAINTENANCE' })
                            });
                            Object.assign(veh, updatedVeh);
                        }

                        this.showMaintenanceModal = false;
                        this.editingMaintenanceId = null;
                        this.newMaintenance = { vehicleId: '', type: '', cost: '', date: '', status: 'PLANIFIÉ', provider: '' };
                        if (this.mainTab === 'dashboard') this.initCharts();
                    } catch (e) {
                        alert('Erreur : ' + (e.message || 'impossible d\'enregistrer l\'entretien.'));
                    }
                },

                async deleteMaintenance(id) {
                    if (!confirm('Voulez-vous vraiment supprimer cet entretien ?')) return;
                    try {
                        await this.apiFetch('/api/maintenances/' + id, { method: 'DELETE' });
                        this.maintenances = this.maintenances.filter(m => m.id !== id);
                        if (this.mainTab === 'dashboard') this.initCharts();
                    } catch (e) {
                        alert('Erreur : ' + (e.message || 'suppression impossible.'));
                    }
                },

                // Gestion des signalements / incidents
                openIncidentModal(i = null) {
                    if (i) {
                        this.editingIncidentId = i.id;
                        this.newIncident = { vehicleId: i.vehicleId, driverId: i.driverId || '', title: i.title, priority: i.priority, description: i.description };
                    } else {
                        this.editingIncidentId = null;
                        this.newIncident = { vehicleId: '', driverId: '', title: '', priority: 'MOYENNE', description: '' };
                    }
                    this.showIncidentModal = true;
                },

                async addIncidentSubmit() {
                    if (!this.newIncident.vehicleId || !this.newIncident.title) {
                        alert('Veuillez sélectionner un véhicule et indiquer le titre du signalement.');
                        return;
                    }
                    const veh = this.vehicles.find(v => v.id == this.newIncident.vehicleId);
                    const drv = this.drivers.find(d => d.id == this.newIncident.driverId);

                    try {
                        if (this.editingIncidentId) {
                            const inc = this.incidents.find(x => x.id === this.editingIncidentId);
                            const payload = {
                                ...inc,
                                vehicleId: veh.id,
                                vehicle: `${veh.brand} ${veh.model} (${veh.plate})`,
                                driverId: drv ? drv.id : '',
                                driver: drv ? drv.name : 'Non précisé',
                                title: this.newIncident.title,
                                priority: this.newIncident.priority,
                                description: this.newIncident.description || 'Aucun détail fourni.'
                            };
                            const updated = await this.apiFetch('/api/incidents/' + this.editingIncidentId, {
                                method: 'PUT',
                                body: JSON.stringify(payload)
                            });
                            if (inc) Object.assign(inc, updated);
                        } else {
                            const created = await this.apiFetch('/api/incidents', {
                                method: 'POST',
                                body: JSON.stringify({
                                    vehicleId: veh.id,
                                    vehicle: `${veh.brand} ${veh.model} (${veh.plate})`,
                                    driverId: drv ? drv.id : '',
                                    driver: drv ? drv.name : 'Non précisé',
                                    title: this.newIncident.title,
                                    priority: this.newIncident.priority,
                                    date: new Date().toISOString().split('T')[0],
                                    status: 'OUVERT',
                                    description: this.newIncident.description || 'Aucun détail fourni.'
                                })
                            });
                            this.incidents.unshift(created);
                        }
                        this.showIncidentModal = false;
                        this.editingIncidentId = null;
                        this.newIncident = { vehicleId: '', driverId: '', title: '', priority: 'MOYENNE', description: '' };
                        if (this.mainTab === 'dashboard') this.initCharts();
                    } catch (e) {
                        alert('Erreur : ' + (e.message || 'impossible d\'enregistrer le signalement.'));
                    }
                },

                async deleteIncident(id) {
                    if (!confirm('Voulez-vous vraiment supprimer ce signalement ?')) return;
                    try {
                        await this.apiFetch('/api/incidents/' + id, { method: 'DELETE' });
                        this.incidents = this.incidents.filter(i => i.id !== id);
                        if (this.mainTab === 'dashboard') this.initCharts();
                    } catch (e) {
                        alert('Erreur : ' + (e.message || 'suppression impossible.'));
                    }
                },

                async updateIncidentStatus(incId, status) {
                    const inc = this.incidents.find(i => i.id === incId);
                    if (!inc) return;
                    try {
                        const updated = await this.apiFetch('/api/incidents/' + incId, {
                            method: 'PUT',
                            body: JSON.stringify({ ...inc, status })
                        });
                        Object.assign(inc, updated);
                        if (this.mainTab === 'dashboard') this.initCharts();
                    } catch (e) {
                        alert('Erreur : ' + (e.message || 'mise à jour impossible.'));
                    }
                },

                // Gestion et traitement des accidents
                openAccidentModal(a = null) {
                    if (a) {
                        this.editingAccidentId = a.id;
                        this.newAccident = { vehicleId: a.vehicleId, driverId: a.driverId || '', date: a.date, location: a.location, damage: a.damage, thirdParty: a.thirdParty, report: a.report, costEstimate: a.costEstimate, status: a.status };
                    } else {
                        this.editingAccidentId = null;
                        this.newAccident = { vehicleId: '', driverId: '', date: '', location: '', damage: '', thirdParty: 'Oui', report: 'Oui', costEstimate: 0, status: 'DECLARÉ' };
                    }
                    this.showAccidentModal = true;
                },

                async addAccidentSubmit() {
                    if (!this.newAccident.vehicleId || !this.newAccident.date || !this.newAccident.location) {
                        alert('Veuillez renseigner le véhicule, la date et le lieu de l\'accident.');
                        return;
                    }
                    const veh = this.vehicles.find(v => v.id == this.newAccident.vehicleId);
                    const drv = this.drivers.find(d => d.id == this.newAccident.driverId);

                    try {
                        if (this.editingAccidentId) {
                            const acc = this.accidents.find(x => x.id === this.editingAccidentId);
                            const payload = {
                                ...acc,
                                vehicleId: veh.id,
                                vehicle: `${veh.brand} ${veh.model} (${veh.plate})`,
                                driverId: drv ? drv.id : '',
                                driver: drv ? drv.name : 'Conducteur',
                                date: this.newAccident.date,
                                location: this.newAccident.location,
                                damage: this.newAccident.damage || 'Dégâts matériels à évaluer',
                                thirdParty: this.newAccident.thirdParty,
                                report: this.newAccident.report,
                                costEstimate: parseInt(this.newAccident.costEstimate) || 0
                            };
                            const updated = await this.apiFetch('/api/accidents/' + this.editingAccidentId, {
                                method: 'PUT',
                                body: JSON.stringify(payload)
                            });
                            if (acc) Object.assign(acc, updated);
                        } else {
                            const created = await this.apiFetch('/api/accidents', {
                                method: 'POST',
                                body: JSON.stringify({
                                    vehicleId: veh.id,
                                    vehicle: `${veh.brand} ${veh.model} (${veh.plate})`,
                                    driverId: drv ? drv.id : '',
                                    driver: drv ? drv.name : 'Conducteur',
                                    date: this.newAccident.date,
                                    location: this.newAccident.location,
                                    damage: this.newAccident.damage || 'Dégâts matériels à évaluer',
                                    thirdParty: this.newAccident.thirdParty,
                                    report: this.newAccident.report,
                                    costEstimate: parseInt(this.newAccident.costEstimate) || 0,
                                    status: 'DECLARÉ'
                                })
                            });
                            this.accidents.unshift(created);

                            if (veh && veh.status !== 'IN_MAINTENANCE') {
                                const updatedVeh = await this.apiFetch('/api/vehicles/' + veh.id, {
                                    method: 'PUT',
                                    body: JSON.stringify({ ...veh, status: 'IN_MAINTENANCE' })
                                });
                                Object.assign(veh, updatedVeh);
                            }
                        }

                        this.showAccidentModal = false;
                        this.editingAccidentId = null;
                        this.newAccident = { vehicleId: '', driverId: '', date: '', location: '', damage: '', thirdParty: 'Oui', report: 'Oui', costEstimate: 0, status: 'DECLARÉ' };
                        if (this.mainTab === 'dashboard') this.initCharts();
                    } catch (e) {
                        alert('Erreur : ' + (e.message || 'impossible d\'enregistrer le dossier accident.'));
                    }
                },

                async deleteAccident(id) {
                    if (!confirm('Voulez-vous vraiment supprimer ce dossier accident ?')) return;
                    try {
                        await this.apiFetch('/api/accidents/' + id, { method: 'DELETE' });
                        this.accidents = this.accidents.filter(a => a.id !== id);
                        if (this.mainTab === 'dashboard') this.initCharts();
                    } catch (e) {
                        alert('Erreur : ' + (e.message || 'suppression impossible.'));
                    }
                },

                async updateAccidentStatus(accId, status) {
                    const acc = this.accidents.find(a => a.id === accId);
                    if (!acc) return;
                    try {
                        const updated = await this.apiFetch('/api/accidents/' + accId, {
                            method: 'PUT',
                            body: JSON.stringify({ ...acc, status })
                        });
                        Object.assign(acc, updated);
                        if (this.mainTab === 'dashboard') this.initCharts();
                    } catch (e) {
                        alert('Erreur : ' + (e.message || 'mise à jour impossible.'));
                    }
                },

                // Gestion des réservations
                // Convertit une réservation en intervalle de dates exploitable (gère une fin non précisée)
                getReservationInterval(startStr, endStr) {
                    const start = new Date(startStr);
                    let end = endStr ? new Date(endStr) : null;
                    if (!end || isNaN(end.getTime())) end = start;
                    return { start, end };
                },

                // Cherche une réservation existante qui chevauche le créneau demandé pour le même véhicule
                findReservationConflict(vehicleId, startStr, endStr, excludeId = null) {
                    if (!vehicleId || !startStr) return null;
                    const { start: newStart, end: newEnd } = this.getReservationInterval(startStr, endStr);
                    if (isNaN(newStart.getTime())) return null;

                    return this.reservations.find(r => {
                        if (excludeId && r.id === excludeId) return false;
                        if (r.vehicleId != vehicleId) return false;
                        if (r.status === 'REJECTED' || r.status === 'CANCELLED') return false;
                        const { start: exStart, end: exEnd } = this.getReservationInterval(r.start, r.end);
                        if (isNaN(exStart.getTime())) return false;
                        // Deux intervalles se chevauchent si chacun commence avant la fin de l'autre
                        return newStart < exEnd && exStart < newEnd;
                    }) || null;
                },

                // Vérification en direct pendant la saisie du formulaire (utilisée pour l'alerte dans la modale)
                get liveReservationConflict() {
                    return this.findReservationConflict(
                        this.newReservation.vehicleId,
                        this.newReservation.start,
                        this.newReservation.end,
                        this.editingReservationId
                    );
                },

                openReservationModal(r = null) {
                    if (r) {
                        this.editingReservationId = r.id;
                        this.newReservation = { vehicleId: r.vehicleId, driverId: r.driverId, start: r.start, end: r.end, purpose: r.purpose };
                    } else {
                        this.editingReservationId = null;
                        this.newReservation = { vehicleId: '', driverId: '', start: '', end: '', purpose: '' };
                    }
                    this.showReservationModal = true;
                },

                async addReservationSubmit() {
                    if (!this.newReservation.vehicleId || !this.newReservation.driverId || !this.newReservation.start) {
                        alert('Veuillez choisir un véhicule, un conducteur et une date de début.');
                        return;
                    }
                    const veh = this.vehicles.find(v => v.id == this.newReservation.vehicleId);
                    const drv = this.drivers.find(d => d.id == this.newReservation.driverId);

                    // Vérification rapide côté client (retour instantané) ; le serveur reste
                    // la source de vérité et revérifie le conflit à la soumission.
                    const conflict = this.findReservationConflict(
                        this.newReservation.vehicleId,
                        this.newReservation.start,
                        this.newReservation.end,
                        this.editingReservationId
                    );
                    if (conflict) {
                        alert(
                            `⛔ Conflit de planning détecté !\n\n` +
                            `${veh.brand} ${veh.model} (${veh.plate}) est déjà réservé par ${conflict.driver} ` +
                            `du ${conflict.start} au ${conflict.end}.\n\n` +
                            `Veuillez choisir un autre créneau ou un autre véhicule.`
                        );
                        return;
                    }

                    const payload = {
                        vehicleId: veh.id,
                        vehicle: `${veh.brand} ${veh.model} (${veh.plate})`,
                        driverId: drv.id,
                        driver: drv ? drv.name : 'Conducteur',
                        start: this.newReservation.start,
                        end: this.newReservation.end || 'Non précisée',
                        purpose: this.newReservation.purpose || 'Mission standard'
                    };

                    try {
                        if (this.editingReservationId) {
                            const res = this.reservations.find(x => x.id === this.editingReservationId);
                            const updated = await this.apiFetch('/api/reservations/' + this.editingReservationId, {
                                method: 'PUT',
                                body: JSON.stringify({ ...res, ...payload })
                            });
                            if (res) Object.assign(res, updated);
                        } else {
                            const created = await this.apiFetch('/api/reservations', {
                                method: 'POST',
                                body: JSON.stringify({ ...payload, status: 'PENDING' })
                            });
                            this.reservations.push(created);
                        }
                        this.showReservationModal = false;
                        this.editingReservationId = null;
                        this.newReservation = { vehicleId: '', driverId: '', start: '', end: '', purpose: '' };
                    } catch (e) {
                        if (e.conflict) {
                            alert(
                                `⛔ Conflit de planning détecté par le serveur !\n\n` +
                                `Ce véhicule est déjà réservé par ${e.conflict.driver} du ${e.conflict.start} au ${e.conflict.end}.`
                            );
                        } else {
                            alert('Erreur : ' + (e.message || 'impossible d\'enregistrer la réservation.'));
                        }
                    }
                },

                async deleteReservation(id) {
                    if (!confirm('Voulez-vous vraiment supprimer cette réservation ?')) return;
                    try {
                        await this.apiFetch('/api/reservations/' + id, { method: 'DELETE' });
                        this.reservations = this.reservations.filter(r => r.id !== id);
                    } catch (e) {
                        alert('Erreur : ' + (e.message || 'suppression impossible.'));
                    }
                },

                async approveReservation(resId) {
                    const res = this.reservations.find(r => r.id === resId);
                    if (!res) return;
                    try {
                        const updated = await this.apiFetch('/api/reservations/' + resId + '/approve', { method: 'PATCH' });
                        Object.assign(res, updated);
                    } catch (e) {
                        alert('Erreur : ' + (e.message || 'validation impossible.'));
                    }
                },

                // Méthodes du lecteur vidéo
                togglePlayVideo() {
                    this.isPlaying = !this.isPlaying;
                    if (this.isPlaying) {
                        this.startVideoPlayback();
                    } else {
                        this.pauseVideoPlayback();
                    }
                },

                startVideoPlayback() {
                    this.speakCurrentScene();
                    this.timer = setInterval(() => {
                        this.currentTime++;

                        let accumulated = 0;
                        for (let i = 0; i < this.scenes.length; i++) {
                            accumulated += this.scenes[i].duration;
                            if (this.currentTime <= accumulated) {
                                if (this.currentSceneIndex !== i) {
                                    this.currentSceneIndex = i;
                                    this.speakCurrentScene();
                                }
                                break;
                            }
                        }

                        if (this.currentTime >= this.videoTotalDuration) {
                            this.pauseVideoPlayback();
                            this.currentTime = this.videoTotalDuration;
                        }
                    }, 1000);
                },

                pauseVideoPlayback() {
                    clearInterval(this.timer);
                    this.isPlaying = false;
                    if (this.speechSynth) this.speechSynth.cancel();
                },

                restartVideo() {
                    this.pauseVideoPlayback();
                    this.currentTime = 0;
                    this.currentSceneIndex = 0;
                    this.togglePlayVideo();
                },

                jumpToScene(index) {
                    let accumulated = 0;
                    for (let i = 0; i < index; i++) {
                        accumulated += this.scenes[i].duration;
                    }
                    this.currentTime = accumulated;
                    this.currentSceneIndex = index;
                    if (this.isPlaying) {
                        this.speakCurrentScene();
                    }
                },

                seekVideo(event) {
                    const rect = event.currentTarget.getBoundingClientRect();
                    const clickX = event.clientX - rect.left;
                    const percentage = clickX / rect.width;
                    this.currentTime = Math.floor(percentage * this.videoTotalDuration);
                    
                    let accumulated = 0;
                    for (let i = 0; i < this.scenes.length; i++) {
                        accumulated += this.scenes[i].duration;
                        if (this.currentTime <= accumulated) {
                            this.currentSceneIndex = i;
                            break;
                        }
                    }
                    if (this.isPlaying) this.speakCurrentScene();
                },

                speakCurrentScene() {
                    if (!this.voiceEnabled || !('speechSynthesis' in window)) return;
                    this.speechSynth.cancel();

                    const text = this.scenes[this.currentSceneIndex].narration;
                    const utterance = new SpeechSynthesisUtterance(text);
                    utterance.lang = 'fr-FR';
                    utterance.rate = 1.0;
                    this.speechSynth.speak(utterance);
                },

                formatTime(seconds) {
                    const mins = Math.floor(seconds / 60);
                    const secs = seconds % 60;
                    return (mins < 10 ? '0' : '') + mins + ':' + (secs < 10 ? '0' : '') + secs;
                },

                copyScriptText() {
                    const text = this.scenes.map((s, i) => `SCÈNE ${i+1}: ${s.title}\nVisuel: ${s.visual}\nNarration: ${s.narration}\n`).join('\n');
                    navigator.clipboard.writeText(text);
                    alert('Le script de Asadiya Flotte PRO a été copié dans le presse-papier !');
                }
            };
        }