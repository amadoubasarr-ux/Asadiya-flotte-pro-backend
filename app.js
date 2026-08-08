        function asadiyaFlotteApp() {
            return {
                // Navigation principale
                mainTab: 'dashboard', // 'dashboard', 'vehicles', 'drivers', 'reservations', 'maintenance', 'incidents', 'accidents', 'video'

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
                paymentFlow: { step: 'idle', planCode: null, planName: null, amount: null, currency: 'XOF' },
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

                async renewMySubscription() {
                    try {
                        await this.apiFetch('/api/subscriptions/me/renew', {
                            method: 'POST',
                            body: JSON.stringify({ reason: 'Renouvellement depuis l\'espace client.' })
                        });
                        const data = await this.apiFetch('/api/auth/me');
                        this.currentUser = data.user;
                        alert('✅ Votre abonnement a été renouvelé avec succès.');
                    } catch (e) {
                        alert('Erreur : ' + (e.message || 'renouvellement impossible.'));
                    }
                },
                // ===== ABONNEMENT & PAIEMENT : VUE PARAMÈTRES (préparation du parcours) =====
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

                preparePaymentPlan(planCode) {
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
                },

                prepareRenewal() {
                    const cur = this.clientSubscription && this.clientSubscription.plan;
                    if (cur) this.preparePaymentPlan(cur.code);
                },

                resetPaymentFlow() {
                    this.paymentFlow = { step: 'idle', planCode: null, planName: null, amount: null, currency: 'XOF' };
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

                // Filtres & Recherche
                vehicleSearch: '',
                vehicleFilterStatus: 'ALL',

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
                // Calcule le statut d'une date de validité : EXPIRED / SOON (≤30j) / OK
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
                    });

                    this.$watch('dashboardPeriod', () => {
                        this.loadDashboardFuelStats().then(() => {
                            if (this.mainTab === 'dashboard') {
                                this.initCharts();
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

                // Recharge les 7 ressources depuis l'API en parallèle
                async loadAllData() {
                    this.isLoadingData = true;
                    this.apiConnectionError = '';
                    try {
                        const [vehicles, drivers, reservations, maintenances, incidents, accidents, fuelLogs] = await Promise.all([
                            this.apiFetch('/api/vehicles'),
                            this.apiFetch('/api/drivers'),
                            this.apiFetch('/api/reservations'),
                            this.apiFetch('/api/maintenances'),
                            this.apiFetch('/api/incidents'),
                            this.apiFetch('/api/accidents'),
                            this.apiFetch('/api/fuel-logs')
                        ]);
                        this.vehicles = vehicles || [];
                        this.drivers = drivers || [];
                        this.reservations = reservations || [];
                        this.maintenances = maintenances || [];
                        this.incidents = incidents || [];
                        this.accidents = accidents || [];
                        this.fuelLogs = fuelLogs || [];
                        // Les stats officielles sont chargées avant le rendu des graphiques.
                        await Promise.all([this.loadFuelStats(), this.loadDashboardFuelStats()]);
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
                // ===== FIN STATISTIQUES CARBURANT =====

                // ===== FIN CONNEXION À L'API =====

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