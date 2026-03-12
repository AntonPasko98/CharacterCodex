import { ToolManager } from '../../../tool-calling.js';

jQuery(async () => {
    const context = SillyTavern.getContext();
    const { eventSource, event_types } = context;
    const MODULE_NAME = 'characterCodex';

    if (typeof window.vis === 'undefined') {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/vis-network/9.1.2/standalone/umd/vis-network.min.js';
        document.head.appendChild(script);
    }

    if (!context.extensionSettings[MODULE_NAME]) context.extensionSettings[MODULE_NAME] = {};
    if (!context.extensionSettings[MODULE_NAME].entities) context.extensionSettings[MODULE_NAME].entities = {};
    if (!context.extensionSettings[MODULE_NAME].cardSize) context.extensionSettings[MODULE_NAME].cardSize = 300;

    // Initialize image proportions
    if (!context.extensionSettings[MODULE_NAME].imgMaxWidth) context.extensionSettings[MODULE_NAME].imgMaxWidth = 100;

    // If the user has an old pixel value (e.g., 220), reset to 75%
    if (!context.extensionSettings[MODULE_NAME].imgMaxHeight || context.extensionSettings[MODULE_NAME].imgMaxHeight === 220) {
        context.extensionSettings[MODULE_NAME].imgMaxHeight = 75;
    }

    let codexData = context.extensionSettings[MODULE_NAME].entities;
    let editingName = null;
    let renderTimer = null;
    let networkNodesDataSet = null;

    if (!context.extensionSettings[MODULE_NAME].nodeSize) context.extensionSettings[MODULE_NAME].nodeSize = 30;
    if (!context.extensionSettings[MODULE_NAME].recurseLimit) context.extensionSettings[MODULE_NAME].recurseLimit = 15;

    ToolManager.RECURSE_LIMIT = context.extensionSettings[MODULE_NAME].recurseLimit;

    // Dynamic vector magic
    function updateDynamicStyles() {
        document.documentElement.style.setProperty('--cdx-card-size-num', context.extensionSettings[MODULE_NAME].cardSize);
        document.documentElement.style.setProperty('--cdx-card-size', context.extensionSettings[MODULE_NAME].cardSize + 'px');
        document.documentElement.style.setProperty('--cdx-img-max-w', context.extensionSettings[MODULE_NAME].imgMaxWidth + '%');
        document.documentElement.style.setProperty('--cdx-img-max-h-num', context.extensionSettings[MODULE_NAME].imgMaxHeight);
    }

    function debouncedRenderGallery() {
        clearTimeout(renderTimer);
        renderTimer = setTimeout(() => {
            if ($('#codex-custom-modal').is(':visible')) renderGallery();
        }, 300);
    }

    const defaultSearchDesc = `Search the 'Character Codex' database to retrieve profiles of characters, locations, or items.

SYMBIOSIS WITH TUNNELVISION:
- Use TunnelVision for global lore.
- Use Character Codex ONLY for specific individuals, their inventory, status, and relations.

MANDATORY RULE (ACTIVE SEARCH):
You MUST proactively use this tool every time to check the cards of ANY characters participating in the current scene or about to appear. Do this BEFORE generating a response!

BULK SEARCH (IMPORTANT!):
The tool accepts an array of 'queries'. If you need to check multiple characters (e.g., 7 people), DO NOT make separate calls!
Pass all their names as a list in a SINGLE call.
Example call: {"queries": ["Rex", "Iris", "Bob", "Alice", "John", "Eve", "Tom"]}`;

    const defaultUpsertDesc = `Create or UPDATE cards in the 'Character Codex'.

STRICT RULES:
1. LANGUAGE: EXCLUSIVELY in English.
2. UNKNOWN: If information is unknown, write: "Unknown".
3. RELATIONS: STRICT JSON {"Name": "Description"}.
4. STATUS: Current location, health. If killed, write "dead".
5. CREATION: If you indicate a relation with a new character, create a card for them too!

BULK UPDATE (IMPORTANT!):
The tool accepts an array 'entities'. If you need to update/create multiple characters, pass ALL of them in one list per call! DO NOT make parallel calls.
For existing cards, pass only the fields that have changed (e.g., status).
Example: {"entities": [ {"name": "Rex", "status": "Shot in the shoulder", "changelog_note": "Wounded"}, {"name": "Iris", "tags": "character", "desc": "New enemy"} ]}`;

    if (!context.extensionSettings[MODULE_NAME].searchPrompt) context.extensionSettings[MODULE_NAME].searchPrompt = defaultSearchDesc;
    if (!context.extensionSettings[MODULE_NAME].upsertPrompt) context.extensionSettings[MODULE_NAME].upsertPrompt = defaultUpsertDesc;

    $('head').append(`
        <style>
            :root {
                --cdx-clr-1: #ff2a5f;
                --cdx-clr-2: #8a2be2;
                --cdx-clr-3: #00e5ff;

                --cdx-glass-bg: rgba(255, 255, 255, 0.05);
                --cdx-glass-border: rgba(255, 255, 255, 0.12);
                --cdx-glass-hover: rgba(255, 255, 255, 0.08);

                --cdx-text-main: #ffffff;
                --cdx-text-sub: #cbd5e1;

                --cdx-card-size-num: 300;
                --cdx-card-size: 300px;
                --cdx-img-max-w: 100%;
                --cdx-img-max-h-num: 75;
            }

            #codex-custom-modal {
                background: rgba(13, 10, 20, 0.85) !important;
                backdrop-filter: blur(25px) !important;
                -webkit-backdrop-filter: blur(25px) !important;
                border: 1px solid var(--cdx-glass-border) !important;
                box-shadow: 0 30px 60px -10px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.1) !important;
                color: var(--cdx-text-main) !important; font-family: 'Segoe UI', system-ui, sans-serif;
                width: 90vw; height: 85vh;
                box-sizing: border-box; display: none; position: absolute; top: 5vh; left: 5vw; z-index: 10010;
                border-radius: 20px; flex-direction: column; overflow: hidden;
            }

            #codex-modal-body-area { position: relative; flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 30px; z-index: 1; }
            #codex-modal-body-area::before {
                content: ''; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
                background:
                    radial-gradient(circle at 10% 20%, rgba(255, 42, 95, 0.12), transparent 40%),
                    radial-gradient(circle at 90% 80%, rgba(0, 229, 255, 0.12), transparent 40%),
                    radial-gradient(circle at 50% 50%, rgba(138, 43, 226, 0.1), transparent 50%);
                z-index: -1; pointer-events: none;
            }

            .codex-header-top {
                display: flex; flex-wrap: wrap; gap: 15px; justify-content: space-between; align-items: center;
                border-bottom: 1px solid var(--cdx-glass-border); padding: 20px 30px;
                background: linear-gradient(180deg, rgba(255,255,255,0.03) 0%, transparent 100%);
                cursor: grab; flex-shrink: 0; position: relative; z-index: 11;
            }
            .codex-header-top:active { cursor: grabbing; }
            .codex-header-controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; flex-grow: 1; justify-content: flex-end; }

            #codex-modal-body-area::-webkit-scrollbar { width: 6px; }
            #codex-modal-body-area::-webkit-scrollbar-track { background: transparent; }
            #codex-modal-body-area::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 10px; }

            .codex-input-styled {
                background: rgba(0,0,0,0.3) !important; border: 1px solid rgba(255,255,255,0.15) !important;
                color: #fff !important; padding: 10px 14px; border-radius: 10px; outline: none; transition: 0.3s; font-size: 0.95em;
            }
            .codex-input-styled:focus {
                background: rgba(0,0,0,0.5) !important; border-color: var(--cdx-clr-3) !important;
                box-shadow: 0 0 15px rgba(0, 229, 255, 0.3);
            }

            /* VECTOR CARD GRID */
            #codex-gallery-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, var(--cdx-card-size));
                gap: 30px;
                justify-content: center; /* Center the grid, no edge stretching */
            }

            /* CARD: VECTOR SCALE */
            .codex-card-pro {
                background: var(--cdx-glass-bg);
                backdrop-filter: blur(15px); -webkit-backdrop-filter: blur(15px);
                border: 1px solid var(--cdx-glass-border);
                box-shadow: 0 10px 30px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.05);
                border-radius: 1em; padding: 0; transition: transform 0.3s, background 0.3s, box-shadow 0.3s;
                display: flex; flex-direction: column; position: relative;
                overflow: visible; z-index: 1;
                /* Main scale multiplier. Base = 300px = 16px font-size */
                font-size: calc((var(--cdx-card-size-num) / 300) * 16px);
            }
            .codex-card-pro:hover {
                transform: translateY(-5px); background: var(--cdx-glass-hover);
                border-color: rgba(255,255,255,0.25);
                box-shadow: 0 20px 40px rgba(0,0,0,0.5), 0 0 30px rgba(138, 43, 226, 0.15);
                z-index: 10;
            }
            .codex-card-pro.pinned { border-color: #fbbf24; box-shadow: 0 0 20px rgba(251, 191, 36, 0.2); }

            .codex-card-header { position: relative; padding: 1.5em 1.25em 1em; text-align: center; display: flex; flex-direction: column; align-items: center; border-radius: 1em 1em 0 0; }
            .codex-card-actions {
                position: absolute; top: 0.75em; right: 0.75em; display: flex; gap: 0.25em; z-index: 20;
                background: rgba(0,0,0,0.4); backdrop-filter: blur(5px); padding: 0.25em; border-radius: 0.6em; border: 1px solid rgba(255,255,255,0.1);
                /* Hidden by default */
                opacity: 0; pointer-events: none; transition: opacity 0.3s ease;
            }
            /* Show on hover */
            .codex-card-pro:hover .codex-card-actions {
                opacity: 1; pointer-events: auto;
            }

            .codex-action-icon { cursor: pointer; font-size: 0.9em; color: var(--cdx-text-sub); padding: 0.35em; transition: 0.2s; border-radius: 0.35em; }
            .codex-action-icon:hover { color: #fff; background: rgba(255,255,255,0.2); }
            .codex-action-icon.pin.active { color: #fbbf24; text-shadow: 0 0 0.6em rgba(251,191,36,0.6); }
            .codex-action-icon.delete:hover { color: #ff2a5f; background: rgba(255, 42, 95, 0.2); }

            .codex-avatar-wrap {
                margin-bottom: 1.1em; display: flex; align-items: center; justify-content: center;
                position: relative; z-index: 5; transition: transform 0.4s ease;
            }
            .codex-card-pro:hover .codex-avatar-wrap { transform: scale(1.02); }

            .codex-avatar-wrap.filled {
                background: transparent; padding: 0; width: 100%; box-shadow: none; border-radius: 0;
            }

            /* PROPORTIONAL IMAGE */
            .codex-avatar-wrap.filled img {
                max-width: var(--cdx-img-max-w); /* Image won't be wider than slider limit */
                width: auto; /* Natural width - removes empty borders! */
                height: auto;
                max-height: calc(var(--cdx-card-size-num) * var(--cdx-img-max-h-num) / 100 * 1px);
                object-fit: contain;
                display: block; border-radius: 0.75em;
                background: transparent;
                box-shadow: 0 1em 2.2em rgba(0,0,0,0.7);
                flex-shrink: 0;
                transition: all 0.3s ease;
            }

            .codex-avatar-wrap.empty {
                max-width: 100%; padding: 0.2em; border-radius: 0.8em;
                background: linear-gradient(135deg, var(--cdx-clr-1), var(--cdx-clr-2), var(--cdx-clr-3));
                box-shadow: 0 0.6em 1.5em rgba(0,0,0,0.5);
            }
            .codex-avatar-wrap.empty i {
                font-size: 3em; color: rgba(255,255,255,0.2); padding: 0.8em; background: rgba(0,0,0,0.6);
                border-radius: 0.25em; width: 100%; display: flex; align-items: center; justify-content: center;
            }

            .codex-card-title { margin: 0; color: #fff; font-size: 1.4em; font-weight: 800; width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 0.1em 0.3em rgba(0,0,0,0.8); }
            .codex-card-lorebook { font-size: 0.75em; color: var(--cdx-clr-3); margin-top: 0.35em; text-transform: uppercase; letter-spacing: 0.1em; font-weight: 700; }

            .codex-tags-area { display: flex; flex-wrap: wrap; gap: 0.35em; justify-content: center; margin-top: 0.9em; }
            .codex-tag-pill {
                background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.15);
                color: #fff; padding: 0.25em 0.75em; border-radius: 1.25em; font-size: 0.7em;
                cursor: pointer; transition: all 0.2s; font-weight: 600; box-shadow: 0 0.1em 0.3em rgba(0,0,0,0.2);
            }
            .codex-tag-pill:hover { background: rgba(255,255,255,0.25); border-color: var(--cdx-clr-3); transform: translateY(-1px); }

            .codex-tabs-nav {
                display: flex; justify-content: space-around; padding: 0.35em; margin: 0 0.9em;
                background: rgba(0,0,0,0.2); border-radius: 0.75em; border: 1px solid rgba(255,255,255,0.05);
            }
            .codex-tab-btn {
                background: transparent; border: none; color: var(--cdx-text-sub); padding: 0.5em 0; flex-grow: 1;
                cursor: pointer; font-size: 1.1em; transition: all 0.3s; border-radius: 0.5em;
            }
            .codex-tab-btn:hover { color: #fff; background: rgba(255,255,255,0.05); }
            .codex-tab-btn.active {
                color: #fff; background: linear-gradient(135deg, var(--cdx-clr-1), var(--cdx-clr-2));
                box-shadow: 0 0.25em 1em rgba(255, 42, 95, 0.4);
            }

            .codex-tab-content { padding: 1.25em; display: none; height: 10em; overflow-y: auto; }
            .codex-tab-content.active { display: block; animation: fadeIn 0.3s ease; }
            @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
            .codex-tab-content::-webkit-scrollbar { width: 4px; } .codex-tab-content::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 4px; }

            .codex-tab-label { font-size: 0.75em; color: var(--cdx-clr-3); letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 0.75em; font-weight: 800; display: flex; align-items: center; gap: 0.5em; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 0.5em; }

            .codex-text-body { white-space: pre-wrap; text-align: left; margin: 0; padding: 0; color: var(--cdx-text-main); line-height: 1.6; font-size: 0.95em; }

            .codex-relation-pill {
                display: flex; flex-direction: column; background: rgba(0,0,0,0.3);
                border: 1px solid rgba(255,255,255,0.08); border-left: 0.25em solid var(--cdx-clr-3);
                border-radius: 0.6em; padding: 0.6em 0.8em; margin: 0 0 0.5em 0; width: 100%; box-sizing: border-box;
                cursor: pointer; transition: all 0.2s; text-align: left;
            }
            .codex-relation-pill:hover { background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.2); transform: translateX(4px); }
            .codex-rel-target { font-weight: 700; color: #fff; font-size: 0.95em; }
            .codex-rel-type { font-size: 0.75em; color: var(--cdx-text-sub); margin-top: 0.2em; text-transform: uppercase; font-weight: 600; letter-spacing: 0.05em; }

            .codex-history-container { border-left: 0.15em solid rgba(255,255,255,0.1); margin-left: 0.6em; padding-left: 1.25em; position: relative; padding-bottom: 0.6em; text-align: left; }
            .codex-history-item { position: relative; margin-bottom: 1.25em; }
            .codex-history-dot { position: absolute; left: -1.6em; top: 0.25em; width: 0.6em; height: 0.6em; border-radius: 50%; background: var(--cdx-clr-3); box-shadow: 0 0 0.6em var(--cdx-clr-3); }
            .codex-history-date { font-size: 0.75em; color: var(--cdx-clr-3); margin-bottom: 0.25em; font-weight: 700; letter-spacing: 0.05em; }

            .codex-btn-primary {
                background: linear-gradient(135deg, var(--cdx-clr-1), var(--cdx-clr-2));
                color: #fff !important; border: none; padding: 10px 20px; border-radius: 10px;
                cursor: pointer; font-weight: 700; transition: all 0.3s ease;
                box-shadow: 0 4px 15px rgba(255, 42, 95, 0.4); text-transform: uppercase; letter-spacing: 1px; font-size: 0.85em;
            }
            .codex-btn-primary:hover { transform: translateY(-2px); box-shadow: 0 8px 25px rgba(138, 43, 226, 0.5); filter: brightness(1.1); }

            .codex-btn-dark {
                background: rgba(255,255,255,0.1); color: #fff !important; border: 1px solid rgba(255,255,255,0.15);
                padding: 10px 16px; border-radius: 10px; cursor: pointer; font-weight: 600; transition: 0.2s; backdrop-filter: blur(5px);
            }
            .codex-btn-dark:hover { background: rgba(255,255,255,0.2); border-color: rgba(255,255,255,0.3); }

            .codex-btn-danger {
                background: rgba(255, 42, 95, 0.1); color: #ff2a5f !important;
                border: 1px solid rgba(255, 42, 95, 0.4); padding: 10px 16px; border-radius: 10px; cursor: pointer; transition: 0.2s; font-weight: 600;
            }
            .codex-btn-danger:hover { background: rgba(255, 42, 95, 0.2); box-shadow: 0 0 15px rgba(255, 42, 95, 0.4); }

            #codex-detail-overlay { display: none; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.85); backdrop-filter: blur(15px); z-index: 10020; align-items: center; justify-content: center; }
            #codex-detail-modal {
                background: rgba(20, 15, 30, 0.9); border: 1px solid rgba(255,255,255,0.1);
                border-radius: 20px; width: 90%; max-width: 800px; max-height: 85vh; display: flex; flex-direction: column; position: relative;
                box-shadow: 0 30px 60px rgba(0,0,0,0.9), 0 0 50px rgba(138, 43, 226, 0.2);
            }
            #codex-detail-close { position: absolute; top: 20px; right: 25px; font-size: 1.5em; color: var(--cdx-text-sub); cursor: pointer; background: none; border: none; transition: 0.2s; z-index: 20; }
            #codex-detail-close:hover { color: var(--cdx-clr-1); transform: rotate(90deg); }
            .codex-detail-header { padding: 40px; background: linear-gradient(180deg, rgba(255,255,255,0.05) 0%, transparent 100%); display: flex; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.05); }

            .codex-detail-avatar-wrap {
                flex-shrink: 0; margin-right: 40px; display: flex; align-items: center; justify-content: center; position: relative;
            }
            .codex-detail-avatar-wrap.filled { background: transparent; padding: 0; }
            .codex-detail-avatar-wrap.empty {
                max-width: 250px; border-radius: 16px; padding: 4px;
                background: linear-gradient(135deg, var(--cdx-clr-1), var(--cdx-clr-3));
                box-shadow: 0 15px 35px rgba(0,0,0,0.6), 0 0 25px rgba(0, 229, 255, 0.3);
            }
            .codex-detail-avatar-wrap img {
                max-width: 100%; max-height: 400px; width: auto; height: auto; object-fit: contain;
                display: block; border-radius: 12px; background: transparent; box-shadow: 0 15px 35px rgba(0,0,0,0.6);
            }
            .codex-detail-avatar-wrap.empty i { font-size: 5em; color: rgba(255,255,255,0.2); padding: 50px; background: rgba(0,0,0,0.6); border-radius: 12px; width: 100%; display: flex; align-items: center; justify-content: center; }

            .codex-modal-nav { display: flex; padding: 0 40px; border-bottom: 1px solid rgba(255,255,255,0.05); background: rgba(0,0,0,0.2); }
            .codex-modal-tab {
                background: transparent; padding: 15px 25px; margin-right: 5px; color: var(--cdx-text-sub);
                cursor: pointer; font-weight: 700; border-bottom: 3px solid transparent; transition: 0.2s;
                text-transform: uppercase; letter-spacing: 1px; font-size: 0.85em;
            }
            .codex-modal-tab:hover { color: #fff; background: rgba(255,255,255,0.05); }
            .codex-modal-tab.active { color: #fff; border-bottom: 3px solid var(--cdx-clr-3); background: linear-gradient(180deg, transparent 0%, rgba(0, 229, 255, 0.15) 100%); }

            .codex-modal-body { padding: 40px; overflow-y: auto; flex-grow: 1; display: none; }
            .codex-modal-body.active { display: block; animation: fadeIn 0.3s ease; }
            .codex-detail-section { margin-bottom: 30px; text-align: left; background: rgba(0,0,0,0.3); padding: 20px; border-radius: 14px; border: 1px solid rgba(255,255,255,0.05); }
            .codex-detail-section h4 { color: var(--cdx-clr-3); margin: 0 0 12px 0; font-size: 0.85em; text-transform: uppercase; letter-spacing: 1.5px; display: flex; align-items: center; border-bottom: 1px solid rgba(0, 229, 255, 0.3); padding-bottom: 10px; }

            #codex-ext-banner {
                background: linear-gradient(45deg, var(--cdx-clr-1), var(--cdx-clr-2), var(--cdx-clr-3), var(--cdx-clr-1));
                background-size: 300% 300%;
                animation: auroraBanner 8s ease infinite;
                border: none; border-radius: 12px; padding: 18px 20px; margin-top: 15px;
                cursor: pointer; display: flex; justify-content: space-between; align-items: center;
                box-shadow: 0 10px 25px rgba(138, 43, 226, 0.4);
                transition: transform 0.2s, box-shadow 0.2s;
            }
            @keyframes auroraBanner {
                0% { background-position: 0% 50%; }
                50% { background-position: 100% 50%; }
                100% { background-position: 0% 50%; }
            }
            #codex-ext-banner:hover { transform: translateY(-2px); box-shadow: 0 15px 35px rgba(0, 229, 255, 0.5); }
            #codex-ext-banner-title { color: #fff; font-weight: 800; font-size: 1.2em; letter-spacing: 1px; text-shadow: 0 2px 5px rgba(0,0,0,0.5); }
            #codex-ext-banner-sub { color: rgba(255,255,255,0.9); font-size: 0.85em; margin-top: 4px; font-weight: 600; text-shadow: 0 1px 3px rgba(0,0,0,0.5); }
            #codex-ext-banner-icon { background: rgba(0,0,0,0.2); padding: 12px; border-radius: 12px; backdrop-filter: blur(5px); border: 1px solid rgba(255,255,255,0.2); color: #fff; font-size: 1.8em; }

            #codex-network-overlay { display: none; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(10, 8, 15, 0.98); z-index: 10030; flex-direction: column; }
            #codex-network-header { display: flex; justify-content: space-between; align-items: center; padding: 20px 30px; background: rgba(0,0,0,0.4); border-bottom: 1px solid rgba(255,255,255,0.05); }
            #codex-network-container { width: 100%; height: calc(100vh - 75px); outline: none; }
        </style>
    `);

    function getCurrentActiveLorebook() {
        const selected = $('#world_editor_select').val();
        if (selected && selected !== 'No Lorebook' && !selected.includes('---')) {
            return $('#world_editor_select option:selected').text().trim() || "Global";
        }
        return "Global";
    }

    function isDead(statusStr) {
        return /(мертв|убит|погиб|dead|deceased)/i.test(statusStr || "");
    }

    function enforceRecurseLimit() {
        if (context.extensionSettings[MODULE_NAME].recurseLimit) {
            ToolManager.RECURSE_LIMIT = context.extensionSettings[MODULE_NAME].recurseLimit;
        }
    }

    function registerCodexTools() {
        try { ToolManager.unregisterFunctionTool("CharacterCodex_Search"); } catch(e){}
        try { ToolManager.unregisterFunctionTool("CharacterCodex_Upsert"); } catch(e){}

        enforceRecurseLimit();

        const activeBook = getCurrentActiveLorebook();
        let activeBookContext = activeBook !== "Global" ? `\nCURRENT ACTIVE LOREBOOK: "${activeBook}".` : "";

        ToolManager.registerFunctionTool({
            name: "CharacterCodex_Search",
            description: context.extensionSettings[MODULE_NAME].searchPrompt + activeBookContext,
            parameters: {
                type: "object",
                properties: {
                    queries: {
                        type: "array",
                        items: { type: "string" },
                        description: "List of names or tags for bulk search. Pass all needed characters here at once!"
                    },
                    query: { type: "string", description: "Name or tag to search for a single character." },
                    lorebook: { type: "string" }
                },
                required: []
            },
            action: async (args) => {
                enforceRecurseLimit();
                const currentActiveBook = getCurrentActiveLorebook();

                let searchTerms = [];
                if (Array.isArray(args.queries)) searchTerms = args.queries.map(q => q.toLowerCase().trim());
                if (typeof args.query === 'string' && args.query.trim() !== '') searchTerms.push(args.query.toLowerCase().trim());
                if (searchTerms.length === 0) return "Error: No search queries provided.";

                let results = [];
                let foundNames = new Set();

                for (const term of searchTerms) {
                    if (!term) continue;
                    for (const [name, data] of Object.entries(codexData)) {
                        if (foundNames.has(name)) continue;

                        let cardLorebook = data.lorebook || "Global";
                        if (cardLorebook !== "Global" && cardLorebook !== currentActiveBook) {
                            continue;
                        }

                        if (name.toLowerCase().includes(term) || (data.tags && data.tags.toLowerCase().includes(term))) {
                            results.push({
                                Entity_Name: name, Tags: data.tags, Description: data.desc,
                                Appearance: data.appearance, Personality: data.personality,
                                Status: data.status, Inventory: data.inventory, Relations: data.relations || {}
                            });
                            foundNames.add(name);
                        }
                    }
                }
                if (results.length > 0) return JSON.stringify(results, null, 2);
                return `No matches found for queries: ${searchTerms.join(', ')}.`;
            }
        });

        ToolManager.registerFunctionTool({
            name: "CharacterCodex_Upsert",
            description: context.extensionSettings[MODULE_NAME].upsertPrompt + activeBookContext,
            parameters: {
                type: "object",
                properties: {
                    entities: {
                        type: "array",
                        description: "Array of character objects for bulk creation/updating.",
                        items: {
                            type: "object",
                            properties: {
                                name: { type: "string" }, tags: { type: "string" }, desc: { type: "string" },
                                appearance: { type: "string" }, personality: { type: "string" },
                                status: { type: "string" }, inventory: { type: "string" },
                                relations: { type: "object" }, changelog_note: { type: "string" },
                                lorebook: { type: "string" }
                            },
                            required: ["name", "tags"]
                        }
                    },
                    name: { type: "string" }, tags: { type: "string" }, desc: { type: "string" }, appearance: { type: "string" }, personality: { type: "string" }, status: { type: "string" }, inventory: { type: "string" }, relations: { type: "object" }, changelog_note: { type: "string" }, lorebook: { type: "string" }
                }
            },
            action: async (args) => {
                enforceRecurseLimit();
                const currentActiveBook = getCurrentActiveLorebook();

                let entitiesToProcess = [];
                if (Array.isArray(args.entities)) entitiesToProcess = args.entities;
                if (args.name && args.tags) entitiesToProcess.push(args);
                if (entitiesToProcess.length === 0) return "Error: No entities provided.";

                let savedNames = [];

                for (const ent of entitiesToProcess) {
                    const name = ent.name ? ent.name.trim() : null;
                    if (!name) continue;

                    const existing = context.extensionSettings[MODULE_NAME].entities[name] || {};

                    let existingLorebook = existing.lorebook || "Global";
                    if (existing.lorebook && existingLorebook !== "Global" && existingLorebook !== currentActiveBook) {
                        continue;
                    }

                    let assignedLorebook = existing.lorebook ? existing.lorebook : (ent.lorebook || "Global");
                    if (!existing.lorebook && assignedLorebook === "Global" && currentActiveBook !== "Global") {
                        assignedLorebook = currentActiveBook;
                    }

                    let parsedRelations = {};
                    if (typeof ent.relations === 'object' && ent.relations !== null) parsedRelations = ent.relations;
                    else if (typeof ent.relations === 'string') { try { parsedRelations = JSON.parse(ent.relations); } catch(e) {} }

                    let history = existing.history || [];

                    if (ent.changelog_note && ent.changelog_note.trim() !== "") history.unshift({ date: new Date().toLocaleString(), note: ent.changelog_note.trim() });
                    else if (!context.extensionSettings[MODULE_NAME].entities[name]) history.unshift({ date: new Date().toLocaleString(), note: "Card created." });

                    context.extensionSettings[MODULE_NAME].entities[name] = {
                        lorebook: assignedLorebook, tags: ent.tags || existing.tags || "", desc: ent.desc || existing.desc || "Unknown",
                        appearance: ent.appearance || existing.appearance || "Unknown", personality: ent.personality || existing.personality || "Unknown",
                        status: ent.status || existing.status || "Unknown", inventory: ent.inventory || existing.inventory || "Empty",
                        relations: Object.keys(parsedRelations).length > 0 ? parsedRelations : (existing.relations || {}),
                        avatar: existing.avatar || "", pinned: existing.pinned || false, history: history, x: existing.x, y: existing.y
                    };
                    savedNames.push(name);
                }

                codexData = context.extensionSettings[MODULE_NAME].entities;
                context.saveSettingsDebounced();
                debouncedRenderGallery();

                if (savedNames.length > 0) {
                    toastr.success(`AI updated Codex: ${savedNames.join(', ')}`);
                    return `Successfully saved/updated: ${savedNames.join(', ')}.`;
                }
                return "Error: Failed to process entities or blocked by Lorebook restrictions.";
            }
        });
    }

    function parseRelationData(rawType) {
        let displayLabel = 'Relation';
        if (typeof rawType === 'object' && rawType !== null) {
            displayLabel = String(rawType.desc || 'Relation');
        } else if (typeof rawType === 'string') {
            if (rawType.includes('|')) displayLabel = rawType.split('|').slice(1).join('|').trim() || rawType.split('|')[0];
            else displayLabel = rawType;
        }
        return displayLabel;
    }

    function generateRelationsHtml(relations, isCharDead) {
        let parsedRels = relations;
        if (typeof parsedRels === 'string') { try { parsedRels = JSON.parse(parsedRels); } catch(e) { parsedRels = {}; } }
        if (!parsedRels || typeof parsedRels !== 'object' || Object.keys(parsedRels).length === 0) return '<div style="color:var(--cdx-text-sub); font-style:italic; padding: 15px; text-align:left;">No known relations.</div>';

        let html = '<div style="display:flex; flex-direction:column; gap:8px;">';
        for (const [target, rawType] of Object.entries(parsedRels)) {
            const displayLabel = parseRelationData(rawType);
            const targetData = codexData[target];
            const isTargetDead = targetData ? isDead(targetData.status) : false;

            let relColor = 'var(--cdx-clr-3)';
            let deadStyle = '';
            if (isTargetDead || isCharDead) {
                relColor = '#475569';
                deadStyle = 'text-decoration: line-through; filter: grayscale(100%); opacity: 0.5;';
            }

            html += `
                <div class="codex-relation-pill" data-target="${target}" title="Open profile: ${target}" style="border-left-color: ${relColor}; ${deadStyle}">
                    <span class="codex-rel-target">${target}</span>
                    <span class="codex-rel-type">${displayLabel}</span>
                </div>`;
        }
        html += '</div>';
        return html;
    }

    function generateHistoryHtml(history) {
        if (!history || history.length === 0) return '<p style="color:var(--cdx-text-sub); font-style:italic;">Change history is empty.</p>';
        let html = '<div class="codex-history-container">';
        history.forEach((h, index) => {
            const dotOpacity = index === 0 ? '1' : '0.4';
            html += `
                <div class="codex-history-item" style="opacity: ${dotOpacity};">
                    <div class="codex-history-dot"></div>
                    <div class="codex-history-date">${h.date}</div>
                    <div class="codex-history-note codex-text-body">${h.note}</div>
                </div>`;
        });
        html += '</div>';
        return html;
    }

    function refreshLorebookDropdown(selectedValue = null) {
        const books = [];
        $('#world_editor_select option').each(function() {
            const text = $(this).text().trim();
            if (text && !text.includes('---') && text !== 'No Lorebook') books.push(text);
        });

        let filterOptions = '<option value="">All lorebooks</option><option value="Global">Global</option>';
        books.forEach(b => filterOptions += `<option value="${b}">${b}</option>`);
        $('#codex-filter-lorebook').html(filterOptions).val($('#codex-filter-lorebook').val() || '');

        let editOptions = '<option value="Global">--- Global ---</option>';
        books.forEach(book => {
            editOptions += `<option value="${book}" ${selectedValue === book ? 'selected' : ''}>${book}</option>`;
        });
        $('#edit-lorebook').html(editOptions);
    }

    function renderGallery() {
        const grid = $('#codex-gallery-grid');
        grid.empty();
        refreshLorebookDropdown();

        const entries = Object.entries(codexData).sort((a, b) => {
            if (a[1].pinned && !b[1].pinned) return -1;
            if (!a[1].pinned && b[1].pinned) return 1;
            return a[0].localeCompare(b[0]);
        });

        if (entries.length === 0) {
            grid.append('<div style="text-align: center; color: var(--cdx-text-sub); padding: 50px; width: 100%; font-size: 1.2em; font-weight: 600;">Database is empty. Create the first entry.</div>');
            return;
        }

        for (const [name, data] of entries) {
            const isPinned = data.pinned ? 'pinned' : '';
            const isCharDead = isDead(data.status);

            const deadFilter = isCharDead ? 'filter: grayscale(100%) opacity(0.6);' : '';
            const deadBorder = isCharDead ? 'background: linear-gradient(135deg, #450a0a, #991b1b); box-shadow: 0 10px 25px rgba(153, 27, 27, 0.5);' : '';

            const hasImg = !!data.avatar;
            const wrapClass = hasImg ? 'filled' : 'empty';
            const avatarHtml = hasImg
                ? `<img src="${data.avatar}" style="${deadFilter}" onerror="this.parentElement.classList.remove('filled'); this.parentElement.classList.add('empty'); this.style.display='none'; this.nextElementSibling.style.display='flex';">
                   <i class="fa-solid fa-image" style="display:none;"></i>`
                : `<i class="fa-solid ${isCharDead ? 'fa-skull' : 'fa-image'}" style="color:${isCharDead ? 'rgba(255, 42, 95, 0.5)' : 'rgba(255,255,255,0.2)'};"></i>`;

            const tagsArray = (data.tags || '').split(',').map(t => t.trim()).filter(t => t);
            const tagsHtml = tagsArray.map(t => `<span class="codex-tag-pill" title="Search tag">#${t}</span>`).join('');
            const relationsHtml = generateRelationsHtml(data.relations, isCharDead);

            grid.append(`
                <div class="codex-card-pro ${isPinned}" data-name="${name}" data-lorebook="${data.lorebook || 'Global'}">
                    <div class="codex-card-header">
                        <div class="codex-card-actions">
                            <i class="fa-solid fa-expand codex-action-icon expand" title="Expand"></i>
                            <i class="fa-solid fa-thumbtack codex-action-icon pin ${data.pinned ? 'active' : ''}" title="Pin"></i>
                            <i class="fa-solid fa-pen codex-action-icon edit" title="Edit"></i>
                            <i class="fa-solid fa-trash-can codex-action-icon delete" title="Delete"></i>
                        </div>
                        <div class="codex-avatar-wrap ${wrapClass}" style="${deadBorder}">
                            ${avatarHtml}
                        </div>
                        <h3 class="codex-card-title" style="${isCharDead ? 'color: var(--cdx-text-sub); text-decoration: line-through;' : ''}" title="${name}">${name}</h3>
                        <div class="codex-card-lorebook"><i class="fa-solid fa-book-atlas" style="margin-right: 4px;"></i>${data.lorebook || 'Global'}</div>
                        ${tagsArray.length > 0 ? `<div class="codex-tags-area">${tagsHtml}</div>` : ''}
                    </div>

                    <div class="codex-tabs-nav">
                        <button class="codex-tab-btn active" data-target="stat" title="Status"><i class="fa-solid fa-heart-pulse"></i></button>
                        <button class="codex-tab-btn" data-target="inv" title="Inventory"><i class="fa-solid fa-box-open"></i></button>
                        <button class="codex-tab-btn" data-target="app" title="Appearance"><i class="fa-solid fa-masks-theater"></i></button>
                        <button class="codex-tab-btn" data-target="pers" title="Personality"><i class="fa-solid fa-dna"></i></button>
                        <button class="codex-tab-btn" data-target="desc" title="Biography"><i class="fa-solid fa-scroll"></i></button>
                        <button class="codex-tab-btn" data-target="rel" title="Relations"><i class="fa-solid fa-diagram-project"></i></button>
                    </div>

                    <div class="codex-tab-content active" data-tab="stat">
                        <div class="codex-tab-label"><i class="fa-solid fa-heart-pulse"></i> Current Status</div>
                        <div class="codex-text-body">${data.status || 'No data'}</div>
                    </div>
                    <div class="codex-tab-content" data-tab="inv">
                        <div class="codex-tab-label"><i class="fa-solid fa-box-open"></i> Inventory</div>
                        <div class="codex-text-body">${data.inventory || 'Empty'}</div>
                    </div>
                    <div class="codex-tab-content" data-tab="app">
                        <div class="codex-tab-label"><i class="fa-solid fa-masks-theater"></i> Appearance</div>
                        <div class="codex-text-body">${data.appearance || 'Unknown'}</div>
                    </div>
                    <div class="codex-tab-content" data-tab="pers">
                        <div class="codex-tab-label"><i class="fa-solid fa-dna"></i> Personality</div>
                        <div class="codex-text-body">${data.personality || 'Unknown'}</div>
                    </div>
                    <div class="codex-tab-content" data-tab="desc">
                        <div class="codex-tab-label"><i class="fa-solid fa-scroll"></i> Biography</div>
                        <div class="codex-text-body">${data.desc || 'No description'}</div>
                    </div>
                    <div class="codex-tab-content" data-tab="rel" style="padding: 10px 15px;">
                        ${relationsHtml}
                    </div>
                </div>
            `);
        }
        applyFilters();
    }

    function openDetailModal(name) {
        const data = codexData[name];
        if (!data) { toastr.warning(`Card "${name}" is not created yet.`); return; }

        const isCharDead = isDead(data.status);
        const deadFilter = isCharDead ? 'filter: grayscale(100%) opacity(0.6);' : '';
        const deadBorder = isCharDead ? 'background: linear-gradient(135deg, #450a0a, #991b1b); box-shadow: 0 15px 35px rgba(153, 27, 27, 0.5);' : '';

        const hasImg = !!data.avatar;
        const wrapClass = hasImg ? 'filled' : 'empty';
        const avatarHtml = hasImg
            ? `<img src="${data.avatar}" style="${deadFilter}" onerror="this.parentElement.classList.remove('filled'); this.parentElement.classList.add('empty'); this.style.display='none'; this.nextElementSibling.style.display='flex';">
               <i class="fa-solid fa-image" style="display:none;"></i>`
            : `<i class="fa-solid ${isCharDead ? 'fa-skull' : 'fa-image'}" style="color:${isCharDead ? 'rgba(255, 42, 95, 0.5)' : 'rgba(255,255,255,0.2)'};"></i>`;

        $('#codex-detail-modal .codex-detail-header').html(`
            <div class="codex-detail-avatar-wrap ${wrapClass}" style="${deadBorder}">
                ${avatarHtml}
            </div>
            <div style="flex-grow: 1;">
                <h2 style="margin:0; font-size:2.5em; color:#fff; font-weight:800; letter-spacing: 0.5px; text-shadow: 0 4px 15px rgba(0,0,0,0.8); ${isCharDead ? 'text-decoration: line-through; color: var(--cdx-text-sub);' : ''}">${name}</h2>
                <div style="color:var(--cdx-clr-3); font-size:0.9em; margin-top:8px; text-transform: uppercase; letter-spacing: 2px; font-weight: 800;">
                    <i class="fa-solid fa-book-atlas" style="margin-right: 6px;"></i> ${data.lorebook || 'Global'}
                </div>
                <div style="margin-top:15px; display:flex; flex-wrap:wrap; gap:8px;">
                    ${(data.tags || 'none').split(',').map(t => `<span class="codex-tag-pill">#${t.trim()}</span>`).join('')}
                </div>
            </div>
        `);

        $('#codex-detail-modal .codex-modal-body[data-tab="info"]').html(`
            <div class="codex-detail-section"><h4><i class="fa-solid fa-heart-pulse" style="margin-right:10px;"></i>Current Status</h4><div class="codex-text-body">${data.status || 'Unknown'}</div></div>
            <div class="codex-detail-section"><h4><i class="fa-solid fa-box-open" style="margin-right:10px;"></i>Inventory</h4><div class="codex-text-body">${data.inventory || 'Empty'}</div></div>
            <div class="codex-detail-section"><h4><i class="fa-solid fa-masks-theater" style="margin-right:10px;"></i>Appearance</h4><div class="codex-text-body">${data.appearance || 'Unknown'}</div></div>
            <div class="codex-detail-section"><h4><i class="fa-solid fa-dna" style="margin-right:10px;"></i>Personality</h4><div class="codex-text-body">${data.personality || 'Unknown'}</div></div>
            <div class="codex-detail-section"><h4><i class="fa-solid fa-scroll" style="margin-right:10px;"></i>General Description / Biography</h4><div class="codex-text-body">${data.desc || 'No description'}</div></div>
        `);

        $('#codex-detail-modal .codex-modal-body[data-tab="rels"]').html(generateRelationsHtml(data.relations, isCharDead));
        $('#codex-detail-modal .codex-modal-body[data-tab="hist"]').html(generateHistoryHtml(data.history));

        $('.codex-modal-tab').removeClass('active');
        $('.codex-modal-tab[data-target="info"]').addClass('active');
        $('.codex-modal-body').removeClass('active');
        $('.codex-modal-body[data-tab="info"]').addClass('active');

        $('#codex-detail-overlay').fadeIn(250).css('display', 'flex');
    }

    function openNetworkMap() {
        if (typeof window.vis === 'undefined') { toastr.info('Map engine is still loading...'); return; }
        $('#codex-network-overlay').fadeIn(300).css('display', 'flex');

        let nodesArr = []; let edgesArr = []; let addedNodes = new Set(); let hasMissingCoords = false;

        for (const [name, data] of Object.entries(codexData)) {
            const isCharDead = isDead(data.status);
            let node = {
                id: name, label: name, shape: data.avatar ? 'circularImage' : 'box', image: data.avatar || undefined,
                color: { background: isCharDead ? '#111' : '#140f1e', border: isCharDead ? '#ff2a5f' : '#00e5ff', highlight: { background: '#1e1b2e', border: '#ff2a5f' } },
                font: { color: isCharDead ? '#64748b' : '#fff', face: 'Segoe UI' }, opacity: isCharDead ? 0.5 : 1
            };
            if (data.x !== undefined && data.y !== undefined) { node.x = data.x; node.y = data.y; } else { hasMissingCoords = true; }
            nodesArr.push(node); addedNodes.add(name);
        }

        for (const [name, data] of Object.entries(codexData)) {
            const isCharDead = isDead(data.status);
            let parsedRels = data.relations;
            if (typeof parsedRels === 'string') { try { parsedRels = JSON.parse(parsedRels); } catch(e) { parsedRels = {}; } }

            if (parsedRels && typeof parsedRels === 'object') {
                for (const [target, rawType] of Object.entries(parsedRels)) {
                    if (!addedNodes.has(target)) {
                        let tNode = { id: target, label: target, shape: 'box', color: { background: '#140f1e', border: '#475569' }, font: { color: '#cbd5e1', face: 'Segoe UI' } };
                        if (context.extensionSettings[MODULE_NAME].dummyCoords && context.extensionSettings[MODULE_NAME].dummyCoords[target]) {
                            tNode.x = context.extensionSettings[MODULE_NAME].dummyCoords[target].x;
                            tNode.y = context.extensionSettings[MODULE_NAME].dummyCoords[target].y;
                        } else {
                            hasMissingCoords = true;
                        }
                        nodesArr.push(tNode); addedNodes.add(target);
                    }

                    const targetData = codexData[target];
                    const isTargetDead = targetData ? isDead(targetData.status) : false;
                    const displayLabel = parseRelationData(rawType);
                    let edgeColor = '#8a2be2'; let isDashed = false;
                    if (isCharDead || isTargetDead) { edgeColor = '#475569'; isDashed = true; }
                    edgesArr.push({ id: `edge_${name}_${target}`, from: name, to: target, customData: displayLabel, arrows: 'to', color: { color: edgeColor, highlight: '#ff2a5f', hover: '#00e5ff' }, width: isDashed ? 1 : 2, dashes: isDashed, selectionWidth: 3 });
                }
            }
        }

        const container = document.getElementById('codex-network-container');
        let currentSize = context.extensionSettings[MODULE_NAME].nodeSize || 30;
        nodesArr.forEach(n => { n.size = currentSize; n.font = Object.assign(n.font || {}, { size: Math.max(12, currentSize * 0.4) }); });

        networkNodesDataSet = new vis.DataSet(nodesArr);
        const data = { nodes: networkNodesDataSet, edges: new vis.DataSet(edgesArr) };
        const options = { nodes: { borderWidth: 2, shadow: true, shapeProperties: { useBorderWithImage: true } }, edges: { smooth: { enabled: true, type: 'continuous', roundness: 0.5 } }, physics: { enabled: hasMissingCoords, solver: 'barnesHut', barnesHut: { gravitationalConstant: -4000, centralGravity: 0.05, springLength: 300, springConstant: 0.04, damping: 0.09, avoidOverlap: 0.1 } }, interaction: { hover: true, selectConnectedEdges: false } };

        const network = new vis.Network(container, data, options);

        function saveAllPositions(positions) {
            if (!context.extensionSettings[MODULE_NAME].dummyCoords) context.extensionSettings[MODULE_NAME].dummyCoords = {};
            for (const nodeId in positions) {
                if (codexData[nodeId]) {
                    codexData[nodeId].x = positions[nodeId].x;
                    codexData[nodeId].y = positions[nodeId].y;
                } else {
                    context.extensionSettings[MODULE_NAME].dummyCoords[nodeId] = { x: positions[nodeId].x, y: positions[nodeId].y };
                }
            }
            context.saveSettingsDebounced();
        }

        if (hasMissingCoords) {
            network.once("stabilizationIterationsDone", function() {
                network.setOptions({ physics: { enabled: false } });
                saveAllPositions(network.getPositions());
            });
        }

        network.on("dragEnd", function (params) {
            if (params.nodes.length > 0) {
                saveAllPositions(network.getPositions(params.nodes));
            }
        });


        network.on("click", function (params) {
            if (params.edges.length > 0 && params.nodes.length === 0) {
                const edge = edgesArr.find(e => e.id === params.edges[0]);
                if (edge) {
                    $('#codex-edge-content').html(`
                        <div style="color:#fff; font-weight:800; font-size:1.3em;">${edge.from}</div>
                        <i class="fa-solid fa-arrow-right" style="color:var(--cdx-clr-3); font-size:1.5em; filter: drop-shadow(0 0 5px rgba(0,229,255,0.5));"></i>
                        <div style="color:#fff; font-weight:800; font-size:1.3em;">${edge.to}</div>
                    `);
                    $('#codex-edge-desc').text(edge.customData);
                    $('#codex-edge-modal').fadeIn(200);
                }
            }
        });
    }

    eventSource.on(event_types.APP_READY, () => {
        updateDynamicStyles();
        registerCodexTools();

        $('#extensions_settings').append(`
            <div id="codex-ext-banner">
                <div>
                    <div id="codex-ext-banner-title">Character Codex</div>
                    <div id="codex-ext-banner-sub">Database / Locations / Relations</div>
                </div>
                <div id="codex-ext-banner-icon">
                    <i class="fa-solid fa-book-journal-whills"></i>
                </div>
            </div>
        `);

        $('body').append(`
            <div id="codex-custom-modal">
                <div class="codex-header-top">
                    <div style="display: flex; align-items: center; gap: 15px;">
                        <div style="background: linear-gradient(135deg, rgba(255, 42, 95, 0.2), rgba(0, 229, 255, 0.2)); padding: 12px; border-radius: 14px; border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(5px);">
                            <i class="fa-solid fa-book-journal-whills fa-2x" style="color: #fff; text-shadow: 0 0 10px rgba(255,255,255,0.5);"></i>
                        </div>
                        <h2 style="margin: 0; font-size: 2em; color: #fff; font-weight: 800; letter-spacing: 0.5px;">
                            Character <span style="background: linear-gradient(90deg, var(--cdx-clr-1), var(--cdx-clr-3)); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">Codex</span>
                        </h2>
                    </div>
                    <div class="codex-header-controls">
                        <div style="position: relative; flex-grow: 1; min-width: 200px;">
                            <i class="fa-solid fa-magnifying-glass" style="position: absolute; left: 14px; top: 50%; transform: translateY(-50%); color: var(--cdx-clr-3);"></i>
                            <input type="text" id="codex-search" class="codex-input-styled" style="margin: 0; padding-left: 40px; width: 100%; box-sizing: border-box;" placeholder="Search (tags, names)...">
                        </div>

                        <select id="codex-filter-lorebook" class="codex-input-styled" style="margin: 0; width: 150px; font-weight: 600;"></select>

                        <div style="display: flex; align-items: center; gap: 10px; background: rgba(0,0,0,0.4); padding: 8px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.1);">
                            <i class="fa-solid fa-border-all" style="color: var(--cdx-text-sub);" title="Card scale"></i>
                            <input type="range" id="codex-size-slider" min="200" max="800" value="${context.extensionSettings[MODULE_NAME].cardSize}" style="width: 80px; accent-color: var(--cdx-clr-1); cursor: pointer;">
                        </div>

                        <button id="open-network-btn" class="codex-btn-dark" title="Network Map"><i class="fa-solid fa-project-diagram"></i></button>
                        <button id="tool-settings-btn" class="codex-btn-dark" title="AI and UI Settings"><i class="fa-solid fa-robot"></i></button>
                        <button id="export-btn" class="codex-btn-dark" title="Export DB"><i class="fa-solid fa-download"></i></button>
                        <label class="codex-btn-dark" title="Import DB" style="cursor:pointer; margin:0;">
                            <i class="fa-solid fa-upload"></i>
                            <input type="file" id="import-file" style="display:none;" accept=".json">
                        </label>
                        <button id="delete-all-btn" class="codex-btn-danger" title="DELETE ALL CARDS"><i class="fa-solid fa-trash-can"></i></button>
                        <button id="add-entry-btn" class="codex-btn-primary"><i class="fa-solid fa-plus" style="margin-right:6px;"></i> Create</button>
                        <button id="close-modal-btn" class="codex-btn-dark" style="margin-left: 10px;"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                </div>

                <div id="codex-modal-body-area">
                    <div id="codex-tool-settings" style="display:none; background: rgba(0,0,0,0.5); backdrop-filter: blur(10px); border: 1px solid var(--cdx-clr-1); border-radius: 16px; padding: 30px; margin-bottom: 30px; box-shadow: 0 20px 40px rgba(0,0,0,0.5);">
                        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 15px; margin-bottom: 25px;">
                            <h3 style="margin: 0; color:#fff; font-size: 1.4em; display: flex; align-items: center; gap: 10px;">
                                <i class="fa-solid fa-microchip" style="color: var(--cdx-clr-1);"></i> AI and UI Settings
                            </h3>
                            <div style="display: flex; align-items: center; gap: 12px;">
                                <span class="codex-label-small" style="margin: 0; color: var(--cdx-text-sub); font-weight: 600;" title="How many times the AI can check cards in one message">Max checks (Recurse Limit):</span>
                                <input type="number" id="codex-recurse-limit" class="codex-input-styled" min="1" max="50" value="${context.extensionSettings[MODULE_NAME].recurseLimit}" style="width: 70px; text-align: center; font-weight: bold;">
                            </div>
                        </div>

                        <!-- EXTREME IMAGE PROPORTIONS -->
                        <div style="display: flex; gap: 20px; margin-bottom: 25px; background: rgba(0,0,0,0.3); padding: 15px 20px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.05);">
                            <div style="flex: 1;">
                                <div style="display: flex; justify-content: space-between; margin-bottom: 5px;">
                                    <span style="color: var(--cdx-clr-3); font-weight: 600; font-size: 0.9em;">Image width (% of card width):</span>
                                    <span id="label-img-w" style="color: #fff; font-weight: bold;">${context.extensionSettings[MODULE_NAME].imgMaxWidth}%</span>
                                </div>
                                <input type="range" id="codex-img-w-slider" min="10" max="500" value="${context.extensionSettings[MODULE_NAME].imgMaxWidth}" style="width: 100%; accent-color: var(--cdx-clr-3);">
                            </div>
                            <div style="flex: 1;">
                                <div style="display: flex; justify-content: space-between; margin-bottom: 5px;">
                                    <span style="color: var(--cdx-clr-1); font-weight: 600; font-size: 0.9em;">Max height (% of card width):</span>
                                    <span id="label-img-h" style="color: #fff; font-weight: bold;">${context.extensionSettings[MODULE_NAME].imgMaxHeight}%</span>
                                </div>
                                <input type="range" id="codex-img-h-slider" min="10" max="300" step="5" value="${context.extensionSettings[MODULE_NAME].imgMaxHeight}" style="width: 100%; accent-color: var(--cdx-clr-1);">
                            </div>
                        </div>

                        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 25px;">
                            <div>
                                <span class="codex-label-small" style="color: var(--cdx-clr-3); font-weight: 700; display: block; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px;">Search Prompt</span>
                                <textarea id="prompt-search-desc" class="codex-input-styled" style="height: 250px; width: 100%; resize: vertical; font-family: monospace; font-size: 0.9em; line-height: 1.4;"></textarea>
                            </div>
                            <div>
                                <span class="codex-label-small" style="color: var(--cdx-clr-1); font-weight: 700; display: block; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px;">Upsert Prompt</span>
                                <textarea id="prompt-upsert-desc" class="codex-input-styled" style="height: 250px; width: 100%; resize: vertical; font-family: monospace; font-size: 0.9em; line-height: 1.4;"></textarea>
                            </div>
                        </div>
                        <div style="text-align: right; margin-top: 25px;">
                            <button id="reset-tool-settings" class="codex-btn-dark" style="margin-right: 15px;">Reset to defaults</button>
                            <button id="save-tool-settings" class="codex-btn-primary">Save Settings</button>
                        </div>
                    </div>

                    <div id="codex-editor" style="display:none; background: rgba(0,0,0,0.5); backdrop-filter: blur(10px); border: 1px solid var(--cdx-clr-3); border-radius: 16px; padding: 30px; margin-bottom: 30px; box-shadow: 0 20px 40px rgba(0,0,0,0.5);">
                        <h3 id="edit-title" style="margin-top:0; color:#fff; font-size: 1.5em; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 15px;">
                            <i class="fa-solid fa-pen-nib" style="color: var(--cdx-clr-3); margin-right: 8px;"></i> <span>New Entry</span>
                        </h3>
                        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 30px; margin-top: 25px;">
                            <div>
                                <span class="codex-label-small" style="color: var(--cdx-text-sub); font-weight: 600;">Avatar (URL or Local)</span>
                                <div style="display:flex; gap:10px; margin-bottom: 20px; margin-top: 6px;">
                                    <input type="text" id="edit-avatar" class="codex-input-styled" placeholder="Image URL..." style="flex-grow:1; margin:0;">
                                    <label class="codex-btn-dark" style="cursor:pointer; margin:0;" title="Upload">
                                        <i class="fa-solid fa-upload"></i>
                                        <input type="file" id="upload-avatar-file" accept="image/*" style="display:none;">
                                    </label>
                                </div>

                                <span class="codex-label-small" style="color: var(--cdx-text-sub); font-weight: 600;">Name</span>
                                <input type="text" id="edit-name" class="codex-input-styled" style="margin-top: 6px; margin-bottom: 20px; width: 100%; box-sizing: border-box; font-weight: 700; font-size: 1.1em;">

                                <span class="codex-label-small" style="color: var(--cdx-text-sub); font-weight: 600;">Lorebook</span>
                                <select id="edit-lorebook" class="codex-input-styled" style="margin-top: 6px; margin-bottom: 20px; width: 100%; font-weight: 600;"></select>

                                <span class="codex-label-small" style="color: var(--cdx-text-sub); font-weight: 600;">Tags (Class + tags)</span>
                                <input type="text" id="edit-tags" class="codex-input-styled" placeholder="character, mage..." style="margin-top: 6px; margin-bottom: 20px; width: 100%; box-sizing: border-box;">

                                <span class="codex-label-small" style="color:var(--cdx-clr-3); font-weight: 700;">Relations (JSON: {"Name": "Relation desc"})</span>
                                <textarea id="edit-relations" class="codex-input-styled" style="margin-top: 6px; height: 100px; width: 100%; box-sizing: border-box; font-family: monospace; font-size:0.9em;"></textarea>
                            </div>
                            <div>
                                <span class="codex-label-small" style="color: var(--cdx-text-sub); font-weight: 600;">General Description / Biography</span>
                                <textarea id="edit-desc" class="codex-input-styled" style="margin-top: 6px; height: 100px; width: 100%; box-sizing: border-box; resize: vertical; margin-bottom: 20px;"></textarea>

                                <span class="codex-label-small" style="color: var(--cdx-text-sub); font-weight: 600;">Current Status</span>
                                <textarea id="edit-stat" class="codex-input-styled" style="margin-top: 6px; height: 70px; width: 100%; box-sizing: border-box; resize: vertical; margin-bottom: 20px;"></textarea>

                                <span class="codex-label-small" style="color: var(--cdx-text-sub); font-weight: 600;">Inventory</span>
                                <textarea id="edit-inv" class="codex-input-styled" style="margin-top: 6px; height: 70px; width: 100%; box-sizing: border-box; resize: vertical; margin-bottom: 20px;"></textarea>

                                <span class="codex-label-small" style="color: var(--cdx-text-sub); font-weight: 600;">Appearance</span>
                                <textarea id="edit-app" class="codex-input-styled" style="margin-top: 6px; height: 70px; width: 100%; box-sizing: border-box; resize: vertical; margin-bottom: 20px;"></textarea>

                                <span class="codex-label-small" style="color: var(--cdx-text-sub); font-weight: 600;">Personality</span>
                                <textarea id="edit-pers" class="codex-input-styled" style="margin-top: 6px; height: 70px; width: 100%; box-sizing: border-box; resize: vertical;"></textarea>
                            </div>
                        </div>
                        <div style="text-align: right; margin-top: 25px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 25px;">
                            <button id="cancel-edit" class="codex-btn-dark" style="margin-right:15px;">Cancel</button>
                            <button id="save-entry" class="codex-btn-primary">Save Card</button>
                        </div>
                    </div>
                    <div id="codex-gallery-grid"></div>
                </div>
            </div>

            <div id="codex-detail-overlay">
                <div id="codex-detail-modal">
                    <button id="codex-detail-close"><i class="fa-solid fa-xmark"></i></button>
                    <div class="codex-detail-header"></div>
                    <div class="codex-modal-nav">
                        <div class="codex-modal-tab active" data-target="info"><i class="fa-solid fa-address-card" style="margin-right:8px;"></i> Dossier</div>
                        <div class="codex-modal-tab" data-target="rels"><i class="fa-solid fa-diagram-project" style="margin-right:8px;"></i> Relations</div>
                        <div class="codex-modal-tab" data-target="hist"><i class="fa-solid fa-clock-rotate-left" style="margin-right:8px;"></i> History</div>
                    </div>
                    <div class="codex-modal-body active" data-tab="info"></div>
                    <div class="codex-modal-body" data-tab="rels"></div>
                    <div class="codex-modal-body" data-tab="hist"></div>
                </div>
            </div>

            <div id="codex-network-overlay">
                <div id="codex-network-header">
                    <h2 style="margin:0; color:#fff; font-size: 1.4em; font-weight: 800;">
                        <i class="fa-solid fa-project-diagram" style="color:var(--cdx-clr-3); margin-right: 10px;"></i> Network Map
                    </h2>
                    <div style="display: flex; align-items: center;">
                        <div style="display: flex; align-items: center; gap: 10px; background: rgba(0,0,0,0.5); padding: 8px 16px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.1); margin-right: 20px;">
                            <i class="fa-solid fa-circle-nodes" style="color: var(--cdx-text-sub);" title="Node size"></i>
                            <input type="range" id="codex-node-size-slider" min="15" max="100" value="${context.extensionSettings[MODULE_NAME].nodeSize || 30}" style="width: 100px; accent-color: var(--cdx-clr-1); cursor: pointer;">
                        </div>
                        <button id="codex-network-reset" class="codex-btn-danger" style="margin-right: 15px;" title="Reset coordinates of all nodes">
                            <i class="fa-solid fa-arrows-rotate" style="margin-right: 6px;"></i> Rebuild
                        </button>
                        <button id="close-network-btn" class="codex-btn-dark">
                            <i class="fa-solid fa-xmark" style="margin-right: 6px;"></i> Close
                        </button>
                    </div>
                </div>
                <div id="codex-network-container"></div>

                <div id="codex-edge-modal" style="display:none; position:absolute; top:50%; left:50%; transform:translate(-50%, -50%); background: rgba(20, 15, 30, 0.95); backdrop-filter: blur(10px); border:1px solid rgba(255,255,255,0.1); border-top:4px solid var(--cdx-clr-3); padding:35px; border-radius:16px; z-index:10040; min-width:350px; box-shadow:0 30px 60px rgba(0,0,0,0.9); text-align:center;">
                    <h3 style="margin-top:0; color:#fff; font-size:1.2em; margin-bottom: 25px; font-weight:800; text-transform:uppercase; letter-spacing:1px;">
                        <i class="fa-solid fa-link" style="color:var(--cdx-clr-3); margin-right:10px;"></i>Relation Details
                    </h3>
                    <div id="codex-edge-content" style="display:flex; align-items:center; justify-content:center; gap:20px; margin-bottom:25px;"></div>
                    <div id="codex-edge-desc" style="background:rgba(0,0,0,0.4); border:1px solid rgba(255,255,255,0.1); padding:15px; border-radius:10px; color:#fff; font-weight:700; font-size:1em; margin-bottom:25px; letter-spacing: 0.5px;"></div>
                    <button id="codex-edge-close" class="codex-btn-primary" style="width:100%;">Close</button>
                </div>
            </div>
        `);

        const modal = $('#codex-custom-modal');
        if (typeof modal.draggable === 'function') {
            modal.draggable({ handle: '.codex-header-top', containment: 'document' })
                 .resizable({ minWidth: 500, minHeight: 400, handles: 'n, e, s, w, ne, se, sw, nw' });
        }

        modal.hide();
        renderGallery();
    });

    eventSource.on(event_types.WORLDINFO_UPDATED, registerCodexTools);

    $(document).on('click', '#codex-ext-banner', () => {
        $('#codex-custom-modal').fadeIn(250).css('display', 'flex');
        renderGallery();
    });

    $(document).on('click', '#close-modal-btn', () => {
        $('#codex-custom-modal').fadeOut(200);
    });

    // CARD SCALE SLIDER
    $(document).on('input', '#codex-size-slider', function() {
        const size = $(this).val();
        document.documentElement.style.setProperty('--cdx-card-size-num', size);
        document.documentElement.style.setProperty('--cdx-card-size', size + 'px');
    });

    $(document).on('change', '#codex-size-slider', function() {
        context.extensionSettings[MODULE_NAME].cardSize = $(this).val();
        context.saveSettingsDebounced();
    });

    // IMAGE PROPORTION SLIDERS (IN PERCENTAGES)
    $(document).on('input', '#codex-img-w-slider', function() {
        $('#label-img-w').text($(this).val() + '%');
        document.documentElement.style.setProperty('--cdx-img-max-w', $(this).val() + '%');
    });

    $(document).on('input', '#codex-img-h-slider', function() {
        $('#label-img-h').text($(this).val() + '%');
        document.documentElement.style.setProperty('--cdx-img-max-h-num', $(this).val());
    });

    $(document).on('click', '.codex-tag-pill', function(e) {
        e.stopPropagation();
        $('#codex-search').val($(this).text().replace('#', '').trim()).trigger('input');
    });

    $(document).on('change', '#upload-avatar-file', function(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function(event) {
            const img = new Image();
            img.onload = function() {
                const canvas = document.createElement('canvas');
                const MAX_SIZE = 1024;
                let width = img.width;
                let height = img.height;

                if (width > height && width > MAX_SIZE) {
                    height *= MAX_SIZE / width;
                    width = MAX_SIZE;
                } else if (height > MAX_SIZE) {
                    width *= MAX_SIZE / height;
                    height = MAX_SIZE;
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                $('#edit-avatar').val(canvas.toDataURL('image/webp', 0.95));
                toastr.success("Image uploaded in high quality!");
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    });

    $(document).on('click', '.codex-tab-btn', function() {
        const card = $(this).closest('.codex-card-pro');
        card.find('.codex-tab-btn').removeClass('active');
        card.find('.codex-tab-content').removeClass('active');

        $(this).addClass('active');
        card.find(`.codex-tab-content[data-tab="${$(this).data('target')}"]`).addClass('active');
    });

    $(document).on('click', '.codex-modal-tab', function() {
        $('.codex-modal-tab').removeClass('active');
        $('.codex-modal-body').removeClass('active');

        $(this).addClass('active');
        $(`.codex-modal-body[data-tab="${$(this).data('target')}"]`).addClass('active');
    });

    $(document).on('click', '#open-network-btn', openNetworkMap);

    $(document).on('click', '#close-network-btn', () => {
        $('#codex-network-overlay').fadeOut(250);
        $('#codex-edge-modal').hide();
    });

    $(document).on('click', '#codex-edge-close', () => {
        $('#codex-edge-modal').fadeOut(200);
    });

    $(document).on('click', '#codex-network-reset', function() {
        if (confirm("Rebuild the map? All saved node coordinates will be reset, and physics will rearrange them.")) {
            for (const name in codexData) {
                delete codexData[name].x;
                delete codexData[name].y;
            }
            context.extensionSettings[MODULE_NAME].dummyCoords = {};
            context.saveSettingsDebounced();
            $('#codex-network-container').empty();
            openNetworkMap();
        }
    });


    $(document).on('click', '.codex-action-icon.expand', function() {
        openDetailModal($(this).closest('.codex-card-pro').attr('data-name'));
    });

    $(document).on('click', '.codex-relation-pill', function() {
        const target = $(this).data('target');
        const exactMatch = Object.keys(codexData).find(k => k.toLowerCase() === String(target).toLowerCase());
        if (exactMatch) {
            openDetailModal(exactMatch);
        } else {
            toastr.warning(`Card "${target}" is not created yet.`);
        }
    });

    $(document).on('click', '#codex-detail-close', () => $('#codex-detail-overlay').fadeOut(250));

    $(document).on('click', '#codex-detail-overlay', function(e) {
        if (e.target === this) $(this).fadeOut(250);
    });

    $(document).on('click', '.codex-action-icon.pin', function() {
        const name = $(this).closest('.codex-card-pro').attr('data-name');
        codexData[name].pinned = !codexData[name].pinned;
        context.saveSettingsDebounced();
        renderGallery();
    });

    $(document).on('click', '#delete-all-btn', function() {
        if (confirm("Delete ALL cards? This is irreversible.")) {
            if (confirm("Are you sure?")) {
                codexData = {};
                context.extensionSettings[MODULE_NAME].entities = codexData;
                context.saveSettingsDebounced();
                renderGallery();
                toastr.success("All cards destroyed.");
            }
        }
    });

    $(document).on('click', '.codex-action-icon.delete', function() {
        const name = $(this).closest('.codex-card-pro').attr('data-name');
        if (confirm(`Delete "${name}"?`)) {
            delete codexData[name];
            context.saveSettingsDebounced();
            $(this).closest('.codex-card-pro').fadeOut(300, function() {
                $(this).remove();
                renderGallery();
            });
        }
    });

    $(document).on('click', '.codex-action-icon.edit', function() {
        $('#codex-tool-settings').slideUp(200);
        const name = $(this).closest('.codex-card-pro').attr('data-name');
        const data = codexData[name];
        editingName = name;

        refreshLorebookDropdown(data.lorebook);
        $('#edit-title span').text('Edit: ' + name);
        $('#edit-name').val(name);
        $('#edit-avatar').val(data.avatar || '');
        $('#edit-tags').val(data.tags || '');
        $('#edit-desc').val(data.desc || '');
        $('#edit-app').val(data.appearance || '');
        $('#edit-pers').val(data.personality || '');
        $('#edit-stat').val(data.status || data.desc || '');
        $('#edit-inv').val(data.inventory || '');

        let rawRelations = data.relations || {};
        if (typeof rawRelations === 'string') {
            try { rawRelations = JSON.parse(rawRelations); } catch(e) { rawRelations = {}; }
        }
        $('#edit-relations').val(JSON.stringify(rawRelations, null, 2));

        $('#codex-editor').slideDown(300);
        $('#codex-modal-body-area').animate({ scrollTop: 0 }, 300);
    });

    function applyFilters() {
        const term = $('#codex-search').val().toLowerCase();
        const selectedBook = $('#codex-filter-lorebook').val();

        $('.codex-card-pro').each(function() {
            const contentMatches = $(this).text().toLowerCase().includes(term);
            const bookMatches = !selectedBook || $(this).attr('data-lorebook') === selectedBook;

            if (contentMatches && bookMatches) {
                $(this).show();
            } else {
                $(this).hide();
            }
        });
    }

    $(document).on('input', '#codex-search', applyFilters);
    $(document).on('change', '#codex-filter-lorebook', applyFilters);

    $(document).on('click', '#export-btn', () => {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(codexData, null, 2));
        const a = document.createElement('a');
        a.href = dataStr;
        a.download = "character_codex_backup.json";
        document.body.appendChild(a);
        a.click();
        a.remove();
    });

    $(document).on('change', '#import-file', function(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                Object.assign(codexData, JSON.parse(e.target.result));
                context.saveSettingsDebounced();
                renderGallery();
                toastr.success("Database imported!");
            } catch (err) {
                toastr.error("JSON read error.");
            }
        };
        reader.readAsText(file);
        $(this).val('');
    });

    $(document).on('click', '#tool-settings-btn', () => {
        $('#codex-editor').slideUp(200);
        $('#prompt-search-desc').val(context.extensionSettings[MODULE_NAME].searchPrompt);
        $('#prompt-upsert-desc').val(context.extensionSettings[MODULE_NAME].upsertPrompt);
        $('#codex-recurse-limit').val(context.extensionSettings[MODULE_NAME].recurseLimit);

        $('#codex-img-w-slider').val(context.extensionSettings[MODULE_NAME].imgMaxWidth);
        $('#label-img-w').text(context.extensionSettings[MODULE_NAME].imgMaxWidth + '%');
        $('#codex-img-h-slider').val(context.extensionSettings[MODULE_NAME].imgMaxHeight);
        $('#label-img-h').text(context.extensionSettings[MODULE_NAME].imgMaxHeight + '%');

        $('#codex-tool-settings').slideToggle(300);
    });

    $(document).on('click', '#save-tool-settings', () => {
        context.extensionSettings[MODULE_NAME].searchPrompt = $('#prompt-search-desc').val().trim();
        context.extensionSettings[MODULE_NAME].upsertPrompt = $('#prompt-upsert-desc').val().trim();

        let newLimit = parseInt($('#codex-recurse-limit').val());
        if (isNaN(newLimit) || newLimit < 1) newLimit = 15;
        context.extensionSettings[MODULE_NAME].recurseLimit = newLimit;

        context.extensionSettings[MODULE_NAME].imgMaxWidth = parseInt($('#codex-img-w-slider').val());
        context.extensionSettings[MODULE_NAME].imgMaxHeight = parseInt($('#codex-img-h-slider').val());

        updateDynamicStyles();
        enforceRecurseLimit();
        context.saveSettingsDebounced();
        registerCodexTools();
        $('#codex-tool-settings').slideUp(300);
        toastr.success("Settings updated!");
    });

    $(document).on('click', '#reset-tool-settings', () => {
        if (confirm("Reset prompts to defaults? This will update the prompts to the latest versions, which handle bulk checks better!")) {
            $('#prompt-search-desc').val(defaultSearchDesc);
            $('#prompt-upsert-desc').val(defaultUpsertDesc);
        }
    });

    $(document).on('click', '#add-entry-btn', () => {
        editingName = null;
        $('#codex-tool-settings').slideUp(200);
        $('#edit-title span').text('New Entry');
        $('#edit-name, #edit-avatar, #edit-tags, #edit-desc, #edit-app, #edit-pers, #edit-stat, #edit-inv').val('');
        $('#edit-relations').val('{}');
        refreshLorebookDropdown(getCurrentActiveLorebook());
        $('#codex-editor').slideDown(300);
        $('#edit-name').focus();
    });

    $(document).on('click', '#cancel-edit', () => {
        $('#codex-editor').slideUp(300);
    });

    $(document).on('click', '#save-entry', function() {
        const name = $('#edit-name').val().trim();
        if (!name) return toastr.error("Name is required!");

        let relData = {};
        try {
            let rawVal = $('#edit-relations').val().trim() || '{}';
            relData = JSON.parse(rawVal);
            if (typeof relData === 'string') relData = JSON.parse(relData);
        } catch (e) {
            return toastr.error("JSON error in Relations!");
        }

        const existing = codexData[name] || {};
        if (editingName && editingName !== name) {
            existing.x = codexData[editingName].x;
            existing.y = codexData[editingName].y;
            delete codexData[editingName];
        }

        codexData[name] = {
            lorebook: $('#edit-lorebook').val(),
            tags: $('#edit-tags').val(),
            avatar: $('#edit-avatar').val().trim(),
            pinned: existing.pinned || false,
            history: existing.history || [],
            desc: $('#edit-desc').val() || "",
            appearance: $('#edit-app').val() || "",
            personality: $('#edit-pers').val() || "",
            status: $('#edit-stat').val() || "",
            inventory: $('#edit-inv').val() || "",
            relations: relData,
            x: existing.x,
            y: existing.y
        };

        context.saveSettingsDebounced();
        $('#codex-editor').slideUp(300);
        renderGallery();
        toastr.success(`Saved: ${name}`);
    });

    $(document).on('input', '#codex-node-size-slider', function() {
        const newSize = parseInt($(this).val());
        if (networkNodesDataSet) {
            const updates = networkNodesDataSet.get().map(n => ({
                id: n.id,
                size: newSize,
                font: Object.assign({}, n.font, { size: Math.max(12, newSize * 0.4) })
            }));
            networkNodesDataSet.update(updates);
        }
    });

    $(document).on('change', '#codex-node-size-slider', function() {
        context.extensionSettings[MODULE_NAME].nodeSize = parseInt($(this).val());
        context.saveSettingsDebounced();
    });

});
