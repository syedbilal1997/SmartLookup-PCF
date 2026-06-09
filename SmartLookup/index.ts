import { IInputs, IOutputs } from "./generated/ManifestTypes";

/** Minimal shape of an entity's metadata that we need from the Web API. */
interface EntityMeta {
  logicalName: string;
  entitySetName: string;
  displayName: string;
  primaryNameAttr: string;
  primaryImageAttr: string | null;
  hasImage: boolean;
}

/** Cached snapshot of a related record's data (raw + image url). */
interface RecordSnapshot {
  id: string;
  entity: EntityMeta;
  name: string;
  imageDataUrl: string | null;
  fields: { logical: string; label: string; value: string }[];
  modifiedOn: string | null;
  state: { label: string; isHealthy: boolean } | null;
}

/** Hard-coded smart defaults so the card looks good with zero config on common entities. */
const SMART_DEFAULTS: Record<string, string[]> = {
  account:     ["industrycode", "telephone1", "address1_city", "revenue"],
  contact:     ["jobtitle", "parentcustomerid", "emailaddress1", "telephone1"],
  lead:        ["subject", "companyname", "leadsourcecode", "emailaddress1"],
  opportunity: ["estimatedvalue", "estimatedclosedate", "stepname"],
  systemuser:  ["jobtitle", "businessunitid", "address1_telephone1", "internalemailaddress"],
  team:        ["businessunitid", "teamtype", "administratorid", "description"],
};

/** Generic fallback list when the entity isn't in SMART_DEFAULTS. We try these in order
 *  and keep the first 4 that actually exist on the record. */
const GENERIC_CANDIDATES = [
  "description",
  "telephone1",
  "address1_city",
  "address1_country",
  "emailaddress1",
  "websiteurl",
  "statuscode",
];

export class SmartLookup implements ComponentFramework.StandardControl<IInputs, IOutputs> {
  private _context: ComponentFramework.Context<IInputs>;
  private _container: HTMLDivElement;
  private _notifyOutputChanged: () => void;

  // Current bound lookup value (cached so we know when it changes)
  private _currentRef: { id: string; entityType: string; name: string } | null = null;

  // Rendered chip + the floating card (card is appended to <body>)
  private _chip: HTMLDivElement | null = null;
  private _card: HTMLDivElement | null = null;

  // Timers + state machine
  private _showTimer: number | null = null;
  private _hideTimer: number | null = null;
  private _isCardOpen = false;
  private _isLoading = false;
  private _isTouchInteraction = false;

  // Per-instance settings
  private _accentColor = "#0078d4";
  private _accentColorDark = "#106ebe";
  private _showOpenButton = true;
  private _position: "auto" | "below" | "above" | "right" = "auto";
  private _hoverDelay = 250;
  private _previewFieldsOverride: string[] = [];
  private _quickViewFormName = "";
  private _useQuickViewForm = true;

  // Cross-instance caches (form may have many SmartLookups; share metadata + record snapshots)
  private static readonly _metaCache = new Map<string, Promise<EntityMeta>>();
  private static readonly _recordCache = new Map<string, Promise<RecordSnapshot>>();
  // QVF cache key is `${entity}|${qvfName}` so different makers using different
  // named QVFs on the same entity don't clobber each other.
  private static readonly _qvfCache = new Map<string, Promise<string[] | null>>();

  /** Standard PCF lifecycle: build the chip and wire interactions. */
  public init(
    context: ComponentFramework.Context<IInputs>,
    notifyOutputChanged: () => void,
    _state: ComponentFramework.Dictionary,
    container: HTMLDivElement
  ): void {
    this._context = context;
    this._container = container;
    this._notifyOutputChanged = notifyOutputChanged;
    container.classList.add("sl-host");
    this._renderChip();
  }

  /** Standard PCF lifecycle: re-read parameters and re-render if the lookup changed. */
  public updateView(context: ComponentFramework.Context<IInputs>): void {
    this._context = context;

    // Settings (read every time so designer changes apply immediately)
    const accent = (context.parameters.accentColor?.raw ?? "").trim();
    if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(accent)) {
      this._accentColor = accent;
      this._accentColorDark = this._shade(accent, -0.18);
    }
    this._showOpenButton = (context.parameters.showOpenButton?.raw as unknown as string) !== "false";
    this._position = (context.parameters.position?.raw as "auto" | "below" | "above" | "right") || "auto";
    this._hoverDelay = Math.max(0, Math.min(2000, Number(context.parameters.hoverDelay?.raw) || 250));
    this._previewFieldsOverride = (context.parameters.previewFields?.raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    this._quickViewFormName = (context.parameters.quickViewFormName?.raw ?? "").trim();
    this._useQuickViewForm = (context.parameters.useQuickViewForm?.raw as unknown as string) !== "false";

    // Resolve the lookup
    const lookupRaw = context.parameters.value?.raw;
    const next = Array.isArray(lookupRaw) && lookupRaw.length > 0 ? lookupRaw[0] : null;

    if (!next || !next.id || !next.entityType) {
      this._currentRef = null;
      this._renderChip();
      this._closeCard();
      return;
    }

    const id = this._normalizeId(next.id);
    if (
      !this._currentRef ||
      this._currentRef.id !== id ||
      this._currentRef.entityType !== next.entityType ||
      this._currentRef.name !== (next.name ?? "")
    ) {
      this._currentRef = { id, entityType: next.entityType, name: next.name ?? "" };
      this._renderChip();
    }
  }

  /** Standard PCF lifecycle: nothing to return upstream — we don't edit the lookup. */
  public getOutputs(): IOutputs {
    return {};
  }

  /** Standard PCF lifecycle: detach the floating card and clear timers. */
  public destroy(): void {
    this._closeCard(true);
    if (this._showTimer !== null) window.clearTimeout(this._showTimer);
    if (this._hideTimer !== null) window.clearTimeout(this._hideTimer);
    if (this._card?.parentNode) this._card.parentNode.removeChild(this._card);
    this._card = null;
  }

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------

  /** Build / rebuild the lookup chip (the always-visible part). */
  private _renderChip(): void {
    this._container.innerHTML = "";

    if (!this._currentRef) {
      const empty = document.createElement("div");
      empty.className = "sl-empty";
      empty.textContent = "—";
      this._container.appendChild(empty);
      this._chip = null;
      return;
    }

    const chip = document.createElement("div");
    chip.className = "sl-chip";
    chip.setAttribute("role", "button");
    chip.setAttribute("tabindex", "0");
    chip.setAttribute(
      "aria-label",
      `${this._currentRef.name} — hover or focus to preview`
    );

    const avatar = document.createElement("span");
    avatar.className = "sl-chip-avatar";
    avatar.style.background = `linear-gradient(135deg, ${this._accentColor}, ${this._accentColorDark})`;
    avatar.textContent = this._initials(this._currentRef.name);

    const name = document.createElement("span");
    name.className = "sl-chip-name";
    name.textContent = this._currentRef.name;

    const chev = document.createElement("span");
    chev.className = "sl-chip-chev";
    chev.setAttribute("aria-hidden", "true");
    chev.textContent = "▾";

    chip.append(avatar, name, chev);
    this._wireChip(chip);

    this._container.appendChild(chip);
    this._chip = chip;
  }

  /** Hover, focus, click, and touch handlers on the chip. */
  private _wireChip(chip: HTMLDivElement): void {
    chip.addEventListener("mouseenter", () => {
      if (this._isTouchInteraction) return;
      this._scheduleOpen();
    });
    chip.addEventListener("mouseleave", () => this._scheduleClose());

    chip.addEventListener("focus", () => this._scheduleOpen(0));
    chip.addEventListener("blur", (e) => {
      // If focus moves into the card itself, keep the card open
      const next = (e as FocusEvent).relatedTarget as Node | null;
      if (next && this._card && this._card.contains(next)) return;
      this._scheduleClose();
    });

    chip.addEventListener("click", (e) => {
      e.preventDefault();
      this._isTouchInteraction = true;
      if (this._isCardOpen) this._closeCard();
      else this._openCard();
    });

    chip.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (this._isCardOpen) this._closeCard();
        else this._openCard();
      } else if (e.key === "Escape") {
        this._closeCard();
      }
    });
  }

  // -----------------------------------------------------------------------
  // Card lifecycle
  // -----------------------------------------------------------------------

  private _scheduleOpen(delay: number = this._hoverDelay): void {
    if (this._hideTimer !== null) {
      window.clearTimeout(this._hideTimer);
      this._hideTimer = null;
    }
    if (this._isCardOpen) return;
    if (this._showTimer !== null) window.clearTimeout(this._showTimer);
    this._showTimer = window.setTimeout(() => this._openCard(), delay);
  }

  private _scheduleClose(): void {
    if (this._showTimer !== null) {
      window.clearTimeout(this._showTimer);
      this._showTimer = null;
    }
    if (!this._isCardOpen) return;
    if (this._hideTimer !== null) window.clearTimeout(this._hideTimer);
    // Give the user a moment to slide the mouse into the card
    this._hideTimer = window.setTimeout(() => this._closeCard(), 180);
  }

  private async _openCard(): Promise<void> {
    if (!this._currentRef) return;
    this._isCardOpen = true;

    // Build skeleton card first (instant feedback)
    this._mountCard(this._buildSkeleton());
    this._positionCard();

    // Load the data and re-render
    try {
      this._isLoading = true;
      const snapshot = await this._loadRecord(this._currentRef.entityType, this._currentRef.id);
      // Possible the user moved away while we were loading — bail.
      if (!this._isCardOpen) return;
      this._mountCard(this._buildCard(snapshot));
      this._positionCard();
    } catch (err) {
      if (!this._isCardOpen) return;
      this._mountCard(this._buildError(err));
      this._positionCard();
    } finally {
      this._isLoading = false;
    }
  }

  private _closeCard(immediate = false): void {
    this._isCardOpen = false;
    if (this._showTimer !== null) {
      window.clearTimeout(this._showTimer);
      this._showTimer = null;
    }
    if (this._hideTimer !== null) {
      window.clearTimeout(this._hideTimer);
      this._hideTimer = null;
    }
    if (this._card) {
      if (immediate) {
        if (this._card.parentNode) this._card.parentNode.removeChild(this._card);
        this._card = null;
      } else {
        this._card.classList.add("sl-card-closing");
        const c = this._card;
        window.setTimeout(() => {
          if (c.parentNode) c.parentNode.removeChild(c);
          if (this._card === c) this._card = null;
        }, 160);
      }
    }
  }

  /** Mount (or replace) the card content inside the floating <div>. */
  private _mountCard(content: HTMLElement): void {
    if (!this._card) {
      const card = document.createElement("div");
      card.className = "sl-card";
      card.setAttribute("role", "dialog");
      card.style.setProperty("--sl-accent", this._accentColor);
      card.style.setProperty("--sl-accent-dark", this._accentColorDark);
      card.addEventListener("mouseenter", () => {
        if (this._hideTimer !== null) {
          window.clearTimeout(this._hideTimer);
          this._hideTimer = null;
        }
      });
      card.addEventListener("mouseleave", () => this._scheduleClose());
      document.body.appendChild(card);
      this._card = card;
    }
    this._card.innerHTML = "";
    this._card.appendChild(content);
  }

  /** Skeleton (loading) state. */
  private _buildSkeleton(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "sl-card-inner sl-skeleton";
    wrap.innerHTML = `
      <div class="sl-card-head">
        <div class="sl-card-avatar sl-sk-block"></div>
        <div style="flex:1">
          <div class="sl-sk-line" style="width:60%"></div>
          <div class="sl-sk-line" style="width:35%;margin-top:6px"></div>
        </div>
      </div>
      <div class="sl-card-grid">
        <div class="sl-sk-tile"></div>
        <div class="sl-sk-tile"></div>
        <div class="sl-sk-tile"></div>
        <div class="sl-sk-tile"></div>
      </div>
      <div class="sl-card-foot">
        <div class="sl-sk-line" style="width:40%"></div>
      </div>`;
    return wrap;
  }

  /** Real card with loaded data. */
  private _buildCard(s: RecordSnapshot): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "sl-card-inner";

    // Head: avatar + name + entity type
    const head = document.createElement("div");
    head.className = "sl-card-head";
    const avatar = document.createElement("div");
    avatar.className = "sl-card-avatar";
    if (s.imageDataUrl) {
      avatar.classList.add("has-image");
      avatar.style.backgroundImage = `url('${s.imageDataUrl}')`;
    } else {
      avatar.style.background = `linear-gradient(135deg, ${this._accentColor}, ${this._accentColorDark})`;
      avatar.textContent = this._initials(s.name);
    }
    const headText = document.createElement("div");
    headText.className = "sl-card-head-text";
    const title = document.createElement("h4");
    title.textContent = s.name;
    const sub = document.createElement("small");
    sub.textContent = s.entity.displayName;
    headText.append(title, sub);
    head.append(avatar, headText);

    // Grid of fields
    const grid = document.createElement("div");
    grid.className = "sl-card-grid";
    const visible = s.fields.slice(0, 6);
    if (visible.length === 0) {
      const note = document.createElement("div");
      note.className = "sl-card-empty-note";
      note.textContent = "No additional fields to preview.";
      grid.appendChild(note);
    } else {
      visible.forEach((f) => {
        const cell = document.createElement("div");
        cell.className = "sl-card-cell";
        const lbl = document.createElement("b");
        lbl.textContent = f.label;
        const val = document.createElement("span");
        val.textContent = f.value;
        val.title = f.value;
        cell.append(lbl, val);
        grid.appendChild(cell);
      });
    }

    // Footer: state tag + modified time + open button
    const foot = document.createElement("div");
    foot.className = "sl-card-foot";

    const footLeft = document.createElement("div");
    footLeft.className = "sl-card-foot-left";
    if (s.modifiedOn) {
      const ts = document.createElement("span");
      ts.className = "sl-card-time";
      ts.textContent = `Updated ${this._relativeTime(s.modifiedOn)}`;
      footLeft.appendChild(ts);
    }
    if (s.state) {
      const tag = document.createElement("span");
      tag.className = `sl-card-tag ${s.state.isHealthy ? "is-healthy" : "is-attention"}`;
      tag.textContent = s.state.label;
      footLeft.appendChild(tag);
    }
    foot.appendChild(footLeft);

    if (this._showOpenButton) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sl-card-open";
      btn.textContent = "Open record";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._openRecord(s.entity.logicalName, s.id);
      });
      foot.appendChild(btn);
    }

    wrap.append(head, grid, foot);
    return wrap;
  }

  /** Error state: deleted record, no access, network failure. */
  private _buildError(err: unknown): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "sl-card-inner sl-card-error";
    wrap.innerHTML = `
      <div class="sl-card-error-icon">⚠</div>
      <div class="sl-card-error-title">Preview unavailable</div>
      <div class="sl-card-error-msg">${this._escape(this._errorMsg(err))}</div>`;
    return wrap;
  }

  /** Place the card relative to the chip. Auto picks the side with most space. */
  private _positionCard(): void {
    if (!this._card || !this._chip) return;
    const chipRect = this._chip.getBoundingClientRect();
    const cardRect = this._card.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;

    let side = this._position;
    if (side === "auto") {
      const below = vh - chipRect.bottom;
      const above = chipRect.top;
      const right = vw - chipRect.right;
      if (right >= cardRect.width + margin && right >= below && right >= above) side = "right";
      else if (below >= above) side = "below";
      else side = "above";
    }

    let top = 0;
    let left = 0;

    if (side === "below") {
      top = chipRect.bottom + margin;
      left = chipRect.left;
    } else if (side === "above") {
      top = chipRect.top - cardRect.height - margin;
      left = chipRect.left;
    } else { // right
      top = chipRect.top;
      left = chipRect.right + margin;
    }

    // Clamp to viewport
    left = Math.max(margin, Math.min(left, vw - cardRect.width - margin));
    top = Math.max(margin, Math.min(top, vh - cardRect.height - margin));

    this._card.style.top = `${top + window.scrollY}px`;
    this._card.style.left = `${left + window.scrollX}px`;
    this._card.dataset.side = side;
  }

  // -----------------------------------------------------------------------
  // Data layer
  // -----------------------------------------------------------------------

  /** Load a record snapshot with retrieve + metadata, using static caches. */
  private async _loadRecord(entityType: string, id: string): Promise<RecordSnapshot> {
    const cacheKey = `${entityType}:${id}`;
    const cached = SmartLookup._recordCache.get(cacheKey);
    if (cached) return cached;

    const promise = this._loadRecordUncached(entityType, id);
    SmartLookup._recordCache.set(cacheKey, promise);
    // If it fails, drop the cache so the next hover retries.
    promise.catch(() => SmartLookup._recordCache.delete(cacheKey));
    return promise;
  }

  private async _loadRecordUncached(entityType: string, id: string): Promise<RecordSnapshot> {
    const meta = await this._loadMeta(entityType);

    // Resolve the set of fields we want to fetch, in priority order:
    //   1. previewFields override   →  power-user escape hatch (explicit wins)
    //   2. Quick View Form          →  admin's chosen configuration via standard Power Apps designer
    //   3. SMART_DEFAULTS[entity]   →  hardcoded for OOB entities
    //   4. Generic candidates       →  final fallback for unknown entities
    let requested: string[];
    let source: "override" | "qvf" | "defaults" | "generic" = "generic";
    if (this._previewFieldsOverride.length > 0) {
      requested = this._previewFieldsOverride.slice(0, 6);
      source = "override";
    } else {
      const qvfFields = this._useQuickViewForm ? await this._loadQvfFields(entityType) : null;
      if (qvfFields && qvfFields.length > 0) {
        requested = qvfFields.slice(0, 6);
        source = "qvf";
      } else if (SMART_DEFAULTS[entityType]) {
        requested = SMART_DEFAULTS[entityType];
        source = "defaults";
      } else {
        requested = GENERIC_CANDIDATES.slice(0, 4);
        source = "generic";
      }
    }
    console.debug(`[SmartLookup] field source for ${entityType}: ${source} (${requested.join(",")})`);

    // Always include primary name + modified time + statecode/statuscode
    const selectAttrs = new Set<string>([
      meta.primaryNameAttr,
      "modifiedon",
      "statecode",
      "statuscode",
      ...requested,
    ]);

    // Build the $select. Lookups need _logical_value form on retrieve.
    const select = Array.from(selectAttrs).join(",");

    let raw: Record<string, unknown>;
    try {
      raw = await this._context.webAPI.retrieveRecord(entityType, id, `?$select=${select}`) as Record<string, unknown>;
    } catch (firstErr) {
      // The bulk select can fail because of:
      //   - one attribute is FLS-protected (common on systemuser.internalemailaddress)
      //   - one attribute doesn't exist on this entity (custom override mis-typed)
      //   - one attribute is a lookup that needs the _<name>_value form
      // Fall back to a minimum-viable pull so the card still shows the name + status.
      console.warn("[SmartLookup] bulk select failed, falling back to minimal:", firstErr);
      try {
        raw = await this._context.webAPI.retrieveRecord(
          entityType,
          id,
          `?$select=${meta.primaryNameAttr},modifiedon,statecode,statuscode`
        ) as Record<string, unknown>;
      } catch (secondErr) {
        // Last resort — retrieve with no select (returns everything readable).
        console.warn("[SmartLookup] minimal select failed, retrieving without select:", secondErr);
        raw = await this._context.webAPI.retrieveRecord(entityType, id) as Record<string, unknown>;
      }
    }

    const name = (raw[meta.primaryNameAttr] as string) || this._currentRef?.name || "(Unnamed)";

    // Image — Power Apps exposes a ready-to-use data URL on entityimage_url for
    // entities that have an image. Falls back gracefully when absent.
    let imageDataUrl: string | null = null;
    const imgUrl = raw["entityimage_url"] as string | undefined;
    if (typeof imgUrl === "string" && imgUrl.length > 0) {
      imageDataUrl = imgUrl.startsWith("http") || imgUrl.startsWith("data:") || imgUrl.startsWith("/")
        ? imgUrl
        : null;
    }

    // Build the field list (with formatted values where Web API provides them).
    const fields = requested
      .map((attr) => this._extractField(raw, attr))
      .filter((f): f is { logical: string; label: string; value: string } => f !== null)
      .slice(0, 6);

    const modifiedOn = (raw["modifiedon"] as string) || null;

    // State — pull a friendly label from statecode and a binary "healthy?" flag from statuscode.
    const stateLabel =
      (raw["statecode@OData.Community.Display.V1.FormattedValue"] as string) ?? null;
    const stateCode = raw["statecode"] as number | undefined;
    const state: { label: string; isHealthy: boolean } | null = stateLabel
      ? { label: stateLabel, isHealthy: stateCode === 0 }
      : null;

    return { id, entity: meta, name, imageDataUrl, fields, modifiedOn, state };
  }

  /** Extract one field's display value, preferring the @OData formatted value. */
  private _extractField(
    raw: Record<string, unknown>,
    attr: string
  ): { logical: string; label: string; value: string } | null {
    // Lookups arrive as _attr_value with a Lookup formatted name annotation
    const lookupKey = `_${attr}_value`;
    if (raw[lookupKey] !== undefined && raw[lookupKey] !== null) {
      const fv = raw[`${lookupKey}@OData.Community.Display.V1.FormattedValue`] as string | undefined;
      if (fv) return { logical: attr, label: this._humanise(attr), value: fv };
    }
    const fv = raw[`${attr}@OData.Community.Display.V1.FormattedValue`] as string | undefined;
    if (typeof fv === "string" && fv.length) {
      return { logical: attr, label: this._humanise(attr), value: fv };
    }
    const v = raw[attr];
    if (v === undefined || v === null || v === "") return null;
    if (typeof v === "object") return null; // Skip nested objects we can't render
    return { logical: attr, label: this._humanise(attr), value: String(v) };
  }

  /** Load entity metadata via the Web API; cached forever for the session. */
  private async _loadMeta(entityName: string): Promise<EntityMeta> {
    const cached = SmartLookup._metaCache.get(entityName);
    if (cached) return cached;

    const promise = this._loadMetaUncached(entityName);
    SmartLookup._metaCache.set(entityName, promise);
    promise.catch(() => SmartLookup._metaCache.delete(entityName));
    return promise;
  }

  private async _loadMetaUncached(entityName: string): Promise<EntityMeta> {
    // PRIMARY: use the official PCF Utility API. This routes to the correct
    // Dataverse URL regardless of where the form is hosted (Sales Hub, Customer
    // Service, embedded Power Apps Studio, etc.). The raw EntityDefinitions
    // fetch used previously fails when window.location is not the org host.
    try {
      interface UtilsExt {
        getEntityMetadata?: (
          entityName: string,
          attributes?: string[]
        ) => Promise<{
          LogicalName?: string;
          EntitySetName?: string;
          DisplayName?: string | { UserLocalizedLabel?: { Label?: string }; LocalizedLabels?: { Label?: string }[] };
          PrimaryNameAttribute?: string;
          PrimaryImageAttribute?: string;
        }>;
      }
      const utils = this._context.utils as unknown as UtilsExt;
      if (utils?.getEntityMetadata) {
        const md = await utils.getEntityMetadata(entityName);
        const display = typeof md.DisplayName === "string"
          ? md.DisplayName
          : md.DisplayName?.UserLocalizedLabel?.Label
            ?? md.DisplayName?.LocalizedLabels?.[0]?.Label
            ?? entityName;
        return {
          logicalName: md.LogicalName ?? entityName,
          entitySetName: md.EntitySetName ?? this._guessSetName(entityName),
          displayName: this._titleCase(display),
          primaryNameAttr: md.PrimaryNameAttribute ?? this._guessPrimaryName(entityName),
          primaryImageAttr: md.PrimaryImageAttribute ?? null,
          hasImage: !!md.PrimaryImageAttribute,
        };
      }
    } catch (utilsErr) {
      // Fall through to the Xrm + fetch fallback below.
      console.warn("[SmartLookup] utils.getEntityMetadata failed:", utilsErr);
    }

    // FALLBACK 1: try Xrm.WebApi.retrieveMultipleRecords against EntityDefinitions.
    // This uses Power Apps' built-in auth + URL routing.
    try {
      interface XrmWebApi {
        WebApi?: {
          retrieveMultipleRecords: (entityLogicalName: string, options?: string) => Promise<{ entities: Record<string, unknown>[] }>;
        };
      }
      const xrm = (window as unknown as { Xrm?: XrmWebApi }).Xrm;
      if (xrm?.WebApi?.retrieveMultipleRecords) {
        const r = await xrm.WebApi.retrieveMultipleRecords(
          "EntityDefinition",
          `?$filter=LogicalName eq '${encodeURIComponent(entityName)}'&$select=LogicalName,EntitySetName,PrimaryNameAttribute,PrimaryImageAttribute,DisplayName`
        );
        const e = r.entities?.[0];
        if (e) {
          const dn = e["DisplayName"] as { UserLocalizedLabel?: { Label?: string }; LocalizedLabels?: { Label?: string }[] } | string | undefined;
          const display = typeof dn === "string"
            ? dn
            : dn?.UserLocalizedLabel?.Label
              ?? dn?.LocalizedLabels?.[0]?.Label
              ?? entityName;
          return {
            logicalName: (e["LogicalName"] as string) ?? entityName,
            entitySetName: (e["EntitySetName"] as string) ?? this._guessSetName(entityName),
            displayName: this._titleCase(display),
            primaryNameAttr: (e["PrimaryNameAttribute"] as string) ?? this._guessPrimaryName(entityName),
            primaryImageAttr: (e["PrimaryImageAttribute"] as string) ?? null,
            hasImage: !!e["PrimaryImageAttribute"],
          };
        }
      }
    } catch (xrmErr) {
      console.warn("[SmartLookup] Xrm.WebApi metadata fallback failed:", xrmErr);
    }

    // FALLBACK 2: hardcoded smart defaults for common entities so the card
    // STILL renders something useful when neither API path works.
    const guessedSet = this._guessSetName(entityName);
    const guessedPrimary = this._guessPrimaryName(entityName);
    return {
      logicalName: entityName,
      entitySetName: guessedSet,
      displayName: this._titleCase(entityName),
      primaryNameAttr: guessedPrimary,
      primaryImageAttr: this._guessImageAttr(entityName),
      hasImage: !!this._guessImageAttr(entityName),
    };
  }

  /** Best-guess pluralisation for a logical name (only used as last-resort fallback). */
  private _guessSetName(entityName: string): string {
    const special: Record<string, string> = {
      systemuser: "systemusers",
      account: "accounts",
      contact: "contacts",
      lead: "leads",
      opportunity: "opportunities",
      incident: "incidents",
      team: "teams",
      businessunit: "businessunits",
      activitypointer: "activitypointers",
    };
    if (special[entityName]) return special[entityName];
    if (entityName.endsWith("y")) return entityName.slice(0, -1) + "ies";
    if (entityName.endsWith("s") || entityName.endsWith("x") || entityName.endsWith("ch") || entityName.endsWith("sh")) return entityName + "es";
    return entityName + "s";
  }

  /** Best-guess primary-name attribute for common entities. */
  private _guessPrimaryName(entityName: string): string {
    const special: Record<string, string> = {
      systemuser: "fullname",
      contact: "fullname",
      lead: "fullname",
      incident: "title",
      activitypointer: "subject",
    };
    return special[entityName] ?? "name";
  }

  /** Best-guess image attribute for common entities. */
  private _guessImageAttr(entityName: string): string | null {
    const withImage = ["account", "contact", "systemuser", "lead"];
    return withImage.includes(entityName) ? "entityimage" : null;
  }

  /** "system user" → "System User". */
  private _titleCase(s: string): string {
    return s.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // -----------------------------------------------------------------------
  // Quick View Form integration
  // -----------------------------------------------------------------------

  /** Resolve the field list from the entity's Quick View Form, if one exists.
   *  Returns null if there's no QVF, the user disabled QVF, or the fetch failed. */
  private async _loadQvfFields(entityName: string): Promise<string[] | null> {
    const cacheKey = `${entityName}|${this._quickViewFormName}`;
    const cached = SmartLookup._qvfCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const promise = this._loadQvfFieldsUncached(entityName);
    SmartLookup._qvfCache.set(cacheKey, promise);
    promise.catch(() => SmartLookup._qvfCache.delete(cacheKey));
    return promise;
  }

  private async _loadQvfFieldsUncached(entityName: string): Promise<string[] | null> {
    try {
      // systemform.type values: 6 = Quick View Form
      // systemform.formactivationstate values: 1 = Active
      // objecttypecode is the entity logical name (lowercased)
      let filter = `objecttypecode eq '${this._escapeOData(entityName)}' and type eq 6 and formactivationstate eq 1`;
      if (this._quickViewFormName) {
        filter += ` and name eq '${this._escapeOData(this._quickViewFormName)}'`;
      }

      const result = await this._context.webAPI.retrieveMultipleRecords(
        "systemform",
        `?$select=name,formxml,formidunique&$filter=${filter}&$top=5`
      );

      if (!result.entities || result.entities.length === 0) return null;

      // If multiple QVFs match (entity has several QVFs and no name specified),
      // prefer the one named like "Information" or first match. Most entities
      // have exactly one QVF, so this rarely matters.
      const qvf = result.entities.find(e => (e.name as string)?.toLowerCase() === "information")
        ?? result.entities[0];

      const formXml = qvf.formxml as string | undefined;
      if (!formXml) return null;

      const fields = this._parseQvfFields(formXml);
      console.debug(`[SmartLookup] QVF "${qvf.name}" on ${entityName} → ${fields.length} fields:`, fields);
      return fields.length > 0 ? fields : null;
    } catch (err) {
      console.warn(`[SmartLookup] Quick View Form lookup failed for ${entityName}:`, err);
      return null;
    }
  }

  /** Parse a Quick View Form's formxml and extract the ordered list of
   *  attribute logical names. Skips labels, sub-grids, and unbound controls. */
  private _parseQvfFields(formXml: string): string[] {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(formXml, "text/xml");
      // If parsing failed entirely, parsererror element is present
      if (doc.getElementsByTagName("parsererror").length > 0) return [];

      // Every form-bound field appears as <control ... datafieldname="X" .../>
      // Sub-grids and quick-view-form-within-form use different attributes and
      // are intentionally skipped (we only render flat fields).
      const controls = doc.querySelectorAll("control[datafieldname]");
      const seen = new Set<string>();
      const out: string[] = [];
      controls.forEach((c) => {
        const name = c.getAttribute("datafieldname");
        if (!name || seen.has(name)) return;
        // Skip system-noise fields that QVFs sometimes include but we never want to show
        if (this._isSystemNoiseField(name)) return;
        seen.add(name);
        out.push(name);
      });
      return out;
    } catch (err) {
      console.warn("[SmartLookup] QVF XML parse failed:", err);
      return [];
    }
  }

  /** True for fields like 'createdon', 'modifiedon', 'statecode', etc. that
   *  we always render in the card's header/footer chrome, not the grid. */
  private _isSystemNoiseField(attr: string): boolean {
    const noise = new Set([
      "createdon", "modifiedon", "createdby", "modifiedby",
      "owninguser", "owningteam", "owningbusinessunit",
      "statecode", "statuscode", "versionnumber",
      "timezoneruleversionnumber", "utcconversiontimezonecode",
      "importsequencenumber", "overriddencreatedon",
    ]);
    return noise.has(attr);
  }

  /** Escape a value for safe use inside an OData $filter string. */
  private _escapeOData(s: string): string {
    return s.replace(/'/g, "''");
  }

  /** Open the related record in a modal dialog via the PCF Navigation API. */
  private _openRecord(entityName: string, id: string): void {
    interface NavExt {
      openForm?: (opts: { entityName: string; entityId: string; openInNewWindow?: boolean }) => Promise<unknown>;
    }
    const nav = (this._context as unknown as { navigation?: NavExt }).navigation;
    if (nav?.openForm) {
      nav.openForm({ entityName, entityId: id }).catch(() => { /* user dismissed */ });
      return;
    }
    // Last-resort: Xrm.Navigation.openForm if running inside the Xrm host
    interface XrmNavigation {
      Navigation?: { openForm: (opts: { entityName: string; entityId: string }) => Promise<unknown> };
    }
    const xrm = (window as unknown as { Xrm?: XrmNavigation }).Xrm;
    if (xrm?.Navigation?.openForm) {
      xrm.Navigation.openForm({ entityName, entityId: id }).catch(() => { /* user dismissed */ });
    }
  }

  // -----------------------------------------------------------------------
  // Small utilities
  // -----------------------------------------------------------------------

  private _initials(name: string): string {
    const parts = name.trim().split(/\s+/).slice(0, 2);
    if (parts.length === 0) return "?";
    return parts.map((p) => p.charAt(0).toUpperCase()).join("");
  }

  /** "jobtitle" → "Job title", "address1_city" → "City", "parentcustomerid" → "Account". */
  private _humanise(attr: string): string {
    const overrides: Record<string, string> = {
      jobtitle: "Job title",
      parentcustomerid: "Account",
      emailaddress1: "Email",
      telephone1: "Phone",
      address1_city: "City",
      address1_country: "Country",
      address1_telephone1: "Phone",
      industrycode: "Industry",
      revenue: "Revenue",
      stepname: "Stage",
      estimatedclosedate: "Close date",
      estimatedvalue: "Est. value",
      websiteurl: "Website",
      internalemailaddress: "Email",
      businessunitid: "Business unit",
      administratorid: "Administrator",
      leadsourcecode: "Source",
      companyname: "Company",
      subject: "Subject",
      teamtype: "Team type",
      description: "Description",
      statuscode: "Status",
    };
    if (overrides[attr]) return overrides[attr];
    // Strip the address1_ etc. prefix and underscores
    return attr
      .replace(/^address1_/, "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  private _normalizeId(id: string): string {
    return id.replace(/^\{|\}$/g, "").toLowerCase();
  }

  /** Convert "2026-06-09T10:23:00Z" → "2h ago" / "yesterday" / "3 days ago" / "12 Jun". */
  private _relativeTime(iso: string): string {
    const then = new Date(iso).getTime();
    const now = Date.now();
    if (isNaN(then)) return "";
    const diff = Math.max(0, now - then);
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days === 1) return "yesterday";
    if (days < 14) return `${days} days ago`;
    return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  /** Darken/lighten a hex by factor (-1..1). Used to derive the secondary accent. */
  private _shade(hex: string, factor: number): string {
    const full = hex.length === 4
      ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
      : hex;
    const r = parseInt(full.slice(1, 3), 16);
    const g = parseInt(full.slice(3, 5), 16);
    const b = parseInt(full.slice(5, 7), 16);
    const shift = (c: number) =>
      Math.max(0, Math.min(255, Math.round(c + (factor < 0 ? c * factor : (255 - c) * factor))));
    return `#${[shift(r), shift(g), shift(b)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  }

  private _escape(s: string): string {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  private _errorMsg(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    if (err && typeof err === "object") {
      const o = err as Record<string, unknown>;
      const m = (o.message ?? o.Message ?? o.errorMessage ?? o.statusText) as string | undefined;
      if (m) return m;
      const inner = o.error as Record<string, unknown> | undefined;
      if (inner?.message) return String(inner.message);
      try { return JSON.stringify(err); } catch { /* noop */ }
    }
    return "The related record couldn't be loaded.";
  }
}
