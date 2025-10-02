import {
    App,
    ButtonComponent,
    Editor,
    Modal,
    Notice,
    Plugin,
    TextComponent,
    ToggleComponent,
    PluginSettingTab,
    Setting,
    SuggestModal,
    MarkdownView
} from 'obsidian';
import { EditorView, Decoration, DecorationSet } from '@codemirror/view';
import { RangeSetBuilder, StateField, StateEffect, StateEffectType } from '@codemirror/state';

interface RfrPluginSettings {
    findText: string;
    replaceText: string;
    useRegEx: boolean;
    selOnly: boolean;
    caseInsensitive: boolean;
    processLineBreak: boolean;
    processTab: boolean;
    prefillFind: boolean;
    savedExpressions: SavedExpression[];
    savedGroups: ExpressionGroup[];
}

interface SavedExpression {
    name: string;
    pattern: string;
    flags: string;
    replace: string;
}

interface ExpressionGroup {
    name: string;
    items: string[]; // expression names
}

const DEFAULT_SETTINGS: RfrPluginSettings = {
    findText: '',
    replaceText: '',
    useRegEx: true,
    selOnly: false,
    caseInsensitive: false,
    processLineBreak: false,
    processTab: false,
    prefillFind: false,
    savedExpressions: [],
    savedGroups: []
}

// logThreshold: 0 ... only error messages
//               9 ... verbose output
const logThreshold = 9;
const logger = (logString: string, logLevel=0): void => {if (logLevel <= logThreshold) console.log ('RegexFiRe: ' + logString)};

export default class RegexFindReplacePlugin extends Plugin {
    settings: RfrPluginSettings;
    highlightEffect: StateEffectType<{ ranges: { from: number; to: number }[] }>;
    highlightField: StateField<DecorationSet>;
    attachedViews: WeakSet<EditorView> = new WeakSet();

    async onload() {
        logger('Loading Plugin...', 9);
        await this.loadSettings();

        this.addSettingTab(new RegexFindReplaceSettingTab(this.app, this));

        // Initialize highlight extension (for real-time regex match preview)
        this.highlightEffect = StateEffect.define<{ ranges: { from: number; to: number }[] }>();
        this.highlightField = StateField.define<DecorationSet>({
            create() { return Decoration.none; },
            update(deco: DecorationSet, tr: any) {
                let next = deco;
                for (const e of tr.effects) {
                    if ((e as StateEffect<any>).is(this.highlightEffect)) {
                        const builder = new RangeSetBuilder<Decoration>();
                        const ranges = (e as any).value.ranges as { from: number; to: number }[];
                        for (const r of ranges) {
                            if (r.to > r.from) builder.add(r.from, r.to, Decoration.mark({ class: 'regex-highlight' }));
                        }
                        next = builder.finish();
                    }
                }
                return next;
            },
            provide: (f: StateField<DecorationSet>) => EditorView.decorations.from(f)
        });


        this.addCommand({
            id: 'obsidian-regex-replace',
            name: '正则查找替换',
            editorCallback: (editor) => {
                new FindAndReplaceModal(this.app, editor, this.settings, this).open();
            },
        });

        // Save current regex (find/replace + flags) as named expression
        this.addCommand({
            id: 'save-current-regex-named',
            name: '保存为命名表达式',
            callback: () => {
                const flags = this.getRegexFlags();
                const preset: SavedExpression = {
                    name: '',
                    pattern: this.settings.findText || '',
                    flags,
                    replace: this.settings.replaceText || ''
                };
                new SaveExpressionModal(this.app, this, preset).open();
            }
        });

        // Run a saved expression by name
        this.addCommand({
            id: 'run-saved-regex-by-name',
            name: '运行已保存表达式',
            editorCallback: (editor) => {
                new RunSavedExpressionSuggest(this.app, this, (expr) => {
                    this.applyExpression(editor, expr);
                }).open();
            }
        });

        // Run multiple saved expressions
        this.addCommand({
            id: 'run-multiple-saved-regex',
            name: '批量运行表达式',
            editorCallback: (editor) => {
                new BatchApplyModal(this.app, this, editor).open();
            }
        });

        // Run a saved group preset
        this.addCommand({
            id: 'run-saved-group',
            name: '运行预设',
            editorCallback: (editor) => {
                new RunSavedGroupSuggest(this.app, this, (group) => {
                    this.applyGroup(editor, group);
                }).open();
            }
        });
    }

	onunload() {
		logger('Bye!', 9);
	}

	async loadSettings() {
		logger('Loading Settings...', 6);
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		logger('   findVal:         ' + this.settings.findText, 6);
		logger('   replaceText:     ' + this.settings.replaceText, 6);
		logger('   caseInsensitive: ' + this.settings.caseInsensitive, 6);
		logger('   processLineBreak: ' + this.settings.processLineBreak, 6);

	}

    async saveSettings() {
        await this.saveData(this.settings);
    }

    getRegexFlags(): string {
        let flags = 'gm';
        if (this.settings.caseInsensitive) flags = flags.concat('i');
        return flags;
    }

    private getCurrentEditorView(): EditorView | undefined {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const cm: EditorView | undefined = (view as any)?.editor?.cm as EditorView | undefined;
        return cm;
    }

    ensureHighlightAttached(): void {
        const cm = this.getCurrentEditorView();
        if (!cm) return;
        if (!(this.attachedViews as any).has(cm)) {
            cm.dispatch({ effects: StateEffect.appendConfig.of(this.highlightField) });
            this.attachedViews.add(cm);
        }
    }

    setHighlights(ranges: { from: number; to: number }[]): void {
        const cm = this.getCurrentEditorView();
        if (!cm) return;
        this.ensureHighlightAttached();
        cm.dispatch({ effects: (this.highlightEffect as any).of({ ranges }) });
    }

    clearHighlights(): void {
        const cm = this.getCurrentEditorView();
        if (!cm) return;
        this.ensureHighlightAttached();
        cm.dispatch({ effects: (this.highlightEffect as any).of({ ranges: [] }) });
    }

    detachHighlight(): void {
        const cm = this.getCurrentEditorView();
        if (!cm) return;
        cm.dispatch({ effects: StateEffect.reconfigure.of([]) });
        // Clearing local registry
        try { (this.attachedViews as any).delete(cm); } catch {}
    }

    saveOrUpdateExpression(expr: SavedExpression): void {
        const idx = this.settings.savedExpressions.findIndex(e => e.name === expr.name);
        if (idx >= 0) this.settings.savedExpressions[idx] = expr; else this.settings.savedExpressions.push(expr);
        this.saveSettings();
        new Notice(`Saved expression: ${expr.name}`);
    }

    deleteExpressionByName(name: string): void {
        this.settings.savedExpressions = this.settings.savedExpressions.filter(e => e.name !== name);
        this.saveSettings();
        new Notice(`Deleted expression: ${name}`);
    }

    saveOrUpdateGroup(group: ExpressionGroup): void {
        const idx = this.settings.savedGroups.findIndex(g => g.name === group.name);
        if (idx >= 0) this.settings.savedGroups[idx] = group; else this.settings.savedGroups.push(group);
        this.saveSettings();
        new Notice(`Saved preset: ${group.name}`);
    }

    deleteGroupByName(name: string): void {
        this.settings.savedGroups = this.settings.savedGroups.filter(g => g.name !== name);
        this.saveSettings();
        new Notice(`Deleted preset: ${name}`);
    }

    applyExpression(editor: Editor, expr: SavedExpression): void {
        const searchRegex = new RegExp(expr.pattern, expr.flags);
        let replaceString = expr.replace;
        // Process special sequences in replace string
        if (this.settings.processLineBreak) replaceString = replaceString.replace(/\\n/gm, '\n');
        if (this.settings.processTab) replaceString = replaceString.replace(/\\t/gm, '\t');

        if (!this.settings.selOnly) {
            const documentText = editor.getValue();
            const rresult = documentText.match(searchRegex);
            if (rresult) {
                editor.setValue(documentText.replace(searchRegex, replaceString));
                new Notice(`Applied '${expr.name}': ${rresult.length} replacement(s) in document`);
            } else new Notice(`No match for '${expr.name}' in document`);
        } else {
            const selectedText = editor.getSelection();
            const rresult = selectedText.match(searchRegex);
            if (rresult) {
                editor.replaceSelection(selectedText.replace(searchRegex, replaceString));
                new Notice(`Applied '${expr.name}': ${rresult.length} replacement(s) in selection`);
            } else new Notice(`No match for '${expr.name}' in selection`);
        }
    }

    applyBatch(editor: Editor, exprs: SavedExpression[]): void {
        if (!exprs.length) { new Notice('No expressions selected'); return; }
        let total = 0;
        let text = this.settings.selOnly ? editor.getSelection() : editor.getValue();
        for (const expr of exprs) {
            const searchRegex = new RegExp(expr.pattern, expr.flags);
            let replaceString = expr.replace;
            if (this.settings.processLineBreak) replaceString = replaceString.replace(/\\n/gm, '\n');
            if (this.settings.processTab) replaceString = replaceString.replace(/\\t/gm, '\t');
            const hits = text.match(searchRegex);
            if (hits) {
                total += hits.length;
                text = text.replace(searchRegex, replaceString);
            }
        }
        if (this.settings.selOnly) editor.replaceSelection(text); else editor.setValue(text);
        new Notice(`Batch applied ${exprs.length} expression(s), ${total} replacement(s)`);
    }

    applyGroup(editor: Editor, group: ExpressionGroup): void {
        const exprs = this.settings.savedExpressions.filter(e => group.items.includes(e.name));
        if (exprs.length === 0) { new Notice(`Preset '${group.name}' has no valid expressions`); return; }
        this.applyBatch(editor, exprs);
    }

}

class FindAndReplaceModal extends Modal {
    constructor(app: App, editor: Editor, settings: RfrPluginSettings, plugin: RegexFindReplacePlugin) {
        super(app);
        this.editor = editor;
        this.settings = settings;
        this.plugin = plugin;
    }

    settings: RfrPluginSettings;
    editor: Editor;
    plugin: RegexFindReplacePlugin;

	onOpen() {
		const { contentEl, titleEl, editor, modalEl } = this;

		modalEl.addClass('find-replace-modal');
		titleEl.setText('Regex Find/Replace');

		const rowClass = 'row';
		const divClass = 'div';
		const noSelection = editor.getSelection() === '';
		let regexFlags = 'gm';
		if (this.settings.caseInsensitive) regexFlags = regexFlags.concat('i');

		logger('No text selected?: ' + noSelection, 9);

		const addTextComponent = (label: string, placeholder: string, postfix=''): [TextComponent, HTMLDivElement] => {
			const containerEl = document.createElement(divClass);
			containerEl.addClass(rowClass);

			const targetEl = document.createElement(divClass);
			targetEl.addClass('input-wrapper');

			const labelEl = document.createElement(divClass);
			labelEl.addClass('input-label');
			labelEl.setText(label);

			const labelEl2 = document.createElement(divClass);
			labelEl2.addClass('postfix-label');
			labelEl2.setText(postfix);

			containerEl.appendChild(labelEl);
			containerEl.appendChild(targetEl);
			containerEl.appendChild(labelEl2);

			const component = new TextComponent(targetEl);
			component.setPlaceholder(placeholder);

			contentEl.append(containerEl);
			return [component, labelEl2];
		};

		const addToggleComponent = (label: string, tooltip: string, hide = false): ToggleComponent => {
			const containerEl = document.createElement(divClass);
			containerEl.addClass(rowClass);
	
			const targetEl = document.createElement(divClass);
			targetEl.addClass(rowClass);

			const component = new ToggleComponent(targetEl);
			component.setTooltip(tooltip);
	
			const labelEl = document.createElement(divClass);
			labelEl.addClass('check-label');
			labelEl.setText(label);
	
			containerEl.appendChild(labelEl);
			containerEl.appendChild(targetEl);
			if (!hide) contentEl.appendChild(containerEl);
			return component;
		};

		// Create input fields
		const findRow = addTextComponent('Find:', 'e.g. (.*)', '/' + regexFlags);
		const findInputComponent = findRow[0];
		const findRegexFlags = findRow[1];
		const replaceRow = addTextComponent('Replace:', 'e.g. $1', this.settings.processLineBreak ? '\\n=LF' : '');
		const replaceWithInputComponent = replaceRow[0];

        // Preview info (matches count)
        const previewInfo = contentEl.createDiv({ cls: 'row' });
        previewInfo.addClass('preview-info');
        previewInfo.setText('Matches: 0');
        // Preview list (each match entry)
        const previewList = contentEl.createDiv({ cls: 'preview-list' });

		// Create and show regular expression toggle switch
		const regToggleComponent = addToggleComponent('Use regular expressions', 'If enabled, regular expressions in the find field are processed as such, and regex groups might be addressed in the replace field');
		
		// Update regex-flags label if regular expressions are enabled or disabled
		regToggleComponent.onChange( regNew => {
			if (regNew) {
				findRegexFlags.setText('/' + regexFlags);
			}
			else {
				findRegexFlags.setText('');
			}
		})

		// Create and show selection toggle switch only if any text is selected
		const selToggleComponent = addToggleComponent('Replace only in selection', 'If enabled, replaces only occurances in the currently selected text', noSelection);

        const updatePreview = () => {
            const pattern = findInputComponent.getValue();
            const useRegex = regToggleComponent.getValue();
            // Clear highlights if not using regex or empty
            if (!useRegex || !pattern) {
                previewInfo.setText('Matches: 0');
                this.plugin.clearHighlights();
                previewList.empty();
                return;
            }
            const flags = regexFlags;
            const selOnly = selToggleComponent.getValue();
            let targetText = selOnly ? editor.getSelection() : editor.getValue();
            let startOffset = 0;
            if (selOnly) {
                try {
                    const fromPos = editor.getCursor('from');
                    startOffset = (editor as any).posToOffset(fromPos) ?? 0;
                } catch (e) { startOffset = 0; }
            }
            try {
                const re = new RegExp(pattern, flags);
                const ranges: { from: number; to: number }[] = [];
                let m: RegExpExecArray | null;
                const items: { text: string; from: number; to: number }[] = [];
                while ((m = re.exec(targetText)) !== null) {
                    const start = m.index;
                    const end = start + (m[0]?.length ?? 0);
                    if (end > start) {
                        ranges.push({ from: startOffset + start, to: startOffset + end });
                        items.push({ text: m[0] ?? '', from: startOffset + start, to: startOffset + end });
                    }
                    // Avoid zero-length infinite loops
                    if (m[0]?.length === 0) re.lastIndex++;
                }
                previewInfo.setText(`Matches: ${ranges.length}`);
                this.plugin.setHighlights(ranges);
                // Render list (limit to 200 entries)
                previewList.empty();
                const limit = 200;
                const show = items.slice(0, limit);
                for (let i = 0; i < show.length; i++) {
                    const it = show[i];
                    const fromPos = (editor as any).offsetToPos(it.from);
                    const el = previewList.createDiv({ cls: 'preview-item' });
                    el.createEl('span', { cls: 'preview-index', text: String(i + 1) });
                    el.createEl('span', { cls: 'preview-text', text: it.text });
                    el.createEl('span', { cls: 'preview-pos', text: `@ ${fromPos.line + 1}:${fromPos.ch + 1}` });
                }
                if (items.length > limit) {
                    const more = previewList.createDiv({ cls: 'preview-more' });
                    more.setText(`… ${items.length - limit} more`);
                }
            } catch (e) {
                previewInfo.setText('Invalid regex');
                this.plugin.clearHighlights();
                previewList.empty();
            }
        };

		// Create Buttons
		const buttonContainerEl = document.createElement(divClass);
		buttonContainerEl.addClass(rowClass);

		const submitButtonTarget = document.createElement(divClass);
		submitButtonTarget.addClass('button-wrapper');
		submitButtonTarget.addClass(rowClass);

		const cancelButtonTarget = document.createElement(divClass);
		cancelButtonTarget.addClass('button-wrapper');
		cancelButtonTarget.addClass(rowClass);

		const submitButtonComponent = new ButtonComponent(submitButtonTarget);
		const cancelButtonComponent = new ButtonComponent(cancelButtonTarget);
		
		cancelButtonComponent.setButtonText('Cancel');
		cancelButtonComponent.onClick(() => {
			logger('Action cancelled.', 8);
			this.close();
		});

		submitButtonComponent.setButtonText('Replace All');
		submitButtonComponent.setCta();
		submitButtonComponent.onClick(() => {
			let resultString = 'No match';
			let scope = '';
			const searchString = findInputComponent.getValue();
			let replaceString = replaceWithInputComponent.getValue();
			const selectedText = editor.getSelection();

			if (searchString === '') {
				new Notice('Nothing to search for!');
				return;
			}

			// Replace line breaks in find-field if option is enabled
			if (this.settings.processLineBreak) {
				logger('Replacing linebreaks in replace-field', 9);
				logger('  old: ' + replaceString, 9);
				replaceString = replaceString.replace(/\\n/gm, '\n');
				logger('  new: ' + replaceString, 9);
			}

			// Replace line breaks in find-field if option is enabled
			if (this.settings.processTab) {
				logger('Replacing tabs in replace-field', 9);
				logger('  old: ' + replaceString, 9);
				replaceString = replaceString.replace(/\\t/gm, '\t');
				logger('  new: ' + replaceString, 9);
			}

			// Check if regular expressions should be used
			if(regToggleComponent.getValue()) {
				logger('USING regex with flags: ' + regexFlags, 8);

				const searchRegex = new RegExp(searchString, regexFlags);
				if(!selToggleComponent.getValue()) {
					logger('   SCOPE: Full document', 9);
					const documentText = editor.getValue();
					const rresult = documentText.match(searchRegex);
					if (rresult) {
						editor.setValue(documentText.replace(searchRegex, replaceString));
						resultString = `Made ${rresult.length} replacement(s) in document`;			
					}
				}
				else {
					logger('   SCOPE: Selection', 9);
					const rresult = selectedText.match(searchRegex);
					if (rresult) {
						editor.replaceSelection(selectedText.replace(searchRegex, replaceString));	
						resultString = `Made ${rresult.length} replacement(s) in selection`;
					}
				}
			}
			else {
				logger('NOT using regex', 8);
				let nrOfHits = 0;
				if(!selToggleComponent.getValue()) {
					logger('   SCOPE: Full document', 9);
					scope = 'selection'
					const documentText = editor.getValue();
					const documentSplit = documentText.split(searchString);
					nrOfHits = documentSplit.length - 1;
					editor.setValue(documentSplit.join(replaceString));
				}
				else {
					logger('   SCOPE: Selection', 9);
					scope = 'document';
					const selectedSplit = selectedText.split(searchString);
					nrOfHits = selectedSplit.length - 1;
					editor.replaceSelection(selectedSplit.join(replaceString));
				}
				resultString = `Made ${nrOfHits} replacement(s) in ${scope}`;
			} 		
			
			// Saving settings (find/replace text and toggle switch states)
			this.settings.findText = searchString;
			this.settings.replaceText = replaceString;
			this.settings.useRegEx = regToggleComponent.getValue();
			this.settings.selOnly = selToggleComponent.getValue();
			this.plugin.saveData(this.settings);

                // Clear highlights after execution
                this.plugin.setHighlights([]);

			this.close();
			new Notice(resultString);					
		});

		// Apply settings
		regToggleComponent.setValue(this.settings.useRegEx);
		selToggleComponent.setValue(this.settings.selOnly);
		replaceWithInputComponent.setValue(this.settings.replaceText);
		
		// Check if the prefill find option is enabled and the selection does not contain linebreaks
		if (this.settings.prefillFind && editor.getSelection().indexOf('\n') < 0 && !noSelection) {
			logger('Found selection without linebreaks and option is enabled -> fill',9);
			findInputComponent.setValue(editor.getSelection());
			selToggleComponent.setValue(false);
		}
		else {
			logger('Restore find text', 9);
			findInputComponent.setValue(this.settings.findText);
		}

        // Wire up preview updates
        findInputComponent.onChange(updatePreview);
        regToggleComponent.onChange(updatePreview);
        selToggleComponent.onChange(updatePreview);
        // Initial preview
        updatePreview();
		
		// Add button row to dialog
		buttonContainerEl.appendChild(submitButtonTarget);
		buttonContainerEl.appendChild(cancelButtonTarget);
		contentEl.appendChild(buttonContainerEl);

		// If no text is selected, disable selection-toggle-switch
		if (noSelection) selToggleComponent.setValue(false);
	}
	
	onClose() {
		const { contentEl } = this;
		contentEl.empty();
        // Clear any remaining highlights when modal closes
        this.plugin.clearHighlights();
	}
}

class RegexFindReplaceSettingTab extends PluginSettingTab {
    plugin: RegexFindReplacePlugin;

	constructor(app: App, plugin: RegexFindReplacePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

    display(): void {
        const {containerEl} = this;
        containerEl.empty();

		containerEl.createEl('h4', {text: 'Regular Expression Settings'});

		new Setting(containerEl)
			.setName('Case Insensitive')
			.setDesc('When using regular expressions, apply the \'/i\' modifier for case insensitive search)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.caseInsensitive)
				.onChange(async (value) => {
					logger('Settings update: caseInsensitive: ' + value);
					this.plugin.settings.caseInsensitive = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h4', {text: 'General Settings'});


		new Setting(containerEl)
			.setName('Process \\n as line break')
			.setDesc('When \'\\n\' is used in the replace field, a \'line break\' will be inserted accordingly')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.processLineBreak)
				.onChange(async (value) => {
					logger('Settings update: processLineBreak: ' + value);
					this.plugin.settings.processLineBreak = value;
					await this.plugin.saveSettings();
				}));


        new Setting(containerEl)
            .setName('Prefill Find Field')
            .setDesc('Copy the currently selected text (if any) into the \'Find\' text field. This setting is only applied if the selection does not contain linebreaks')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.prefillFind)
                .onChange(async (value) => {
                    logger('Settings update: prefillFind: ' + value);
                    this.plugin.settings.prefillFind = value;
                    await this.plugin.saveSettings();
                }));

        // Saved expressions management
        containerEl.createEl('h4', {text: 'Saved Expressions'});

        // Add Expression button
        const addContainer = containerEl.createDiv();
        const addButton = new ButtonComponent(addContainer);
        addButton.setButtonText('Add Expression');
        addButton.onClick(() => {
            const preset: SavedExpression = { name: '', pattern: this.plugin.settings.findText || '', flags: this.plugin.getRegexFlags(), replace: this.plugin.settings.replaceText || '' };
            new SaveExpressionModal(this.app, this.plugin, preset, () => this.display()).open();
        });

        // List saved expressions
        if (this.plugin.settings.savedExpressions.length === 0) {
            const emptyEl = containerEl.createDiv();
            emptyEl.setText('No saved expressions yet.');
        } else {
            this.plugin.settings.savedExpressions.forEach(expr => {
                const row = new Setting(containerEl)
                    .setName(expr.name)
                    .setDesc(`/${expr.flags}  pattern: ${expr.pattern}  replace: ${expr.replace}`);
                row.addButton(btn => btn.setButtonText('Edit').onClick(() => {
                    new SaveExpressionModal(this.app, this.plugin, {...expr}, () => this.display()).open();
                }));
                row.addButton(btn => btn.setWarning().setButtonText('Delete').onClick(() => {
                    this.plugin.deleteExpressionByName(expr.name);
                    this.display();
                }));
            });
        }

        // Saved groups management
        containerEl.createEl('h4', { text: 'Saved Presets (Groups)' });

        const addGroupContainer = containerEl.createDiv();
        const addGroupButton = new ButtonComponent(addGroupContainer);
        addGroupButton.setButtonText('Add Preset');
        addGroupButton.onClick(() => {
            new SaveGroupModal(this.app, this.plugin).open();
        });

        if (this.plugin.settings.savedGroups.length === 0) {
            const emptyGroupsEl = containerEl.createDiv();
            emptyGroupsEl.setText('No presets yet. Save from batch dialog or here.');
        } else {
            this.plugin.settings.savedGroups.forEach(group => {
                const row = new Setting(containerEl)
                    .setName(group.name)
                    .setDesc(`Items: ${group.items.join(', ')}`);
                row.addButton(btn => btn.setButtonText('Run').onClick(() => {
                    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                    const editor = view?.editor;
                    if (!editor) { new Notice('No active editor'); return; }
                    this.plugin.applyGroup(editor, group);
                }));
                row.addButton(btn => btn.setButtonText('Edit').onClick(() => {
                    new SaveGroupModal(this.app, this.plugin, group, () => this.display()).open();
                }));
                row.addButton(btn => btn.setWarning().setButtonText('Delete').onClick(() => {
                    this.plugin.deleteGroupByName(group.name);
                    this.display();
                }));
            });
        }
    }
}

// Modal to save or edit a named expression
class SaveExpressionModal extends Modal {
    plugin: RegexFindReplacePlugin;
    expr: SavedExpression;
    onSaved?: () => void;

    constructor(app: App, plugin: RegexFindReplacePlugin, preset: SavedExpression, onSaved?: () => void) {
        super(app);
        this.plugin = plugin;
        this.expr = preset;
        this.onSaved = onSaved;
    }

    onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText('Save Named Expression');

        const nameRow = contentEl.createDiv({ cls: 'row' });
        nameRow.createDiv({ cls: 'input-label' }).setText('Name:');
        const nameWrap = nameRow.createDiv({ cls: 'input-wrapper' });
        const nameInput = new TextComponent(nameWrap);
        nameInput.setPlaceholder('e.g. Title case');
        nameInput.setValue(this.expr.name || '');

        const pattRow = contentEl.createDiv({ cls: 'row' });
        pattRow.createDiv({ cls: 'input-label' }).setText('Pattern:');
        const pattWrap = pattRow.createDiv({ cls: 'input-wrapper' });
        const pattInput = new TextComponent(pattWrap);
        pattInput.setPlaceholder('e.g. (.*)');
        pattInput.setValue(this.expr.pattern || '');

        const flagsRow = contentEl.createDiv({ cls: 'row' });
        flagsRow.createDiv({ cls: 'input-label' }).setText('Flags:');
        const flagsWrap = flagsRow.createDiv({ cls: 'input-wrapper' });
        const flagsInput = new TextComponent(flagsWrap);
        flagsInput.setPlaceholder('e.g. gmi');
        flagsInput.setValue(this.expr.flags || this.plugin.getRegexFlags());

        const replRow = contentEl.createDiv({ cls: 'row' });
        replRow.createDiv({ cls: 'input-label' }).setText('Replace:');
        const replWrap = replRow.createDiv({ cls: 'input-wrapper' });
        const replInput = new TextComponent(replWrap);
        replInput.setPlaceholder('e.g. $1');
        replInput.setValue(this.expr.replace || '');

        const btnRow = contentEl.createDiv({ cls: 'row button-wrapper' });
        const saveBtn = new ButtonComponent(btnRow);
        saveBtn.setCta();
        saveBtn.setButtonText('Save');
        saveBtn.onClick(() => {
            const name = nameInput.getValue().trim();
            const pattern = pattInput.getValue();
            const flags = flagsInput.getValue().trim() || 'gm';
            const replace = replInput.getValue();
            if (!name) { new Notice('Name is required'); return; }
            try {
                // Validate regex
                // eslint-disable-next-line no-new
                new RegExp(pattern, flags);
            } catch (e) {
                new Notice('Invalid pattern or flags');
                return;
            }
            this.plugin.saveOrUpdateExpression({ name, pattern, flags, replace });
            this.close();
            if (this.onSaved) this.onSaved();
        });

        const cancelBtn = new ButtonComponent(btnRow);
        cancelBtn.setButtonText('Cancel');
        cancelBtn.onClick(() => this.close());
    }

    onClose() { this.contentEl.empty(); }
}

// Suggest modal to pick a saved expression by name
class RunSavedExpressionSuggest extends SuggestModal<SavedExpression> {
    plugin: RegexFindReplacePlugin;
    onChoose: (expr: SavedExpression) => void;

    constructor(app: App, plugin: RegexFindReplacePlugin, onChoose: (expr: SavedExpression) => void) {
        super(app);
        this.plugin = plugin;
        this.onChoose = onChoose;
        this.setPlaceholder('Type to search saved expressions...');
    }

    getSuggestions(query: string): SavedExpression[] {
        const q = query.toLowerCase();
        return this.plugin.settings.savedExpressions.filter(e => e.name.toLowerCase().includes(q));
    }

    renderSuggestion(expr: SavedExpression, el: HTMLElement) {
        el.createEl('div', { text: expr.name });
        el.createEl('small', { text: `/${expr.flags} ${expr.pattern} -> ${expr.replace}` });
    }

    onChooseSuggestion(expr: SavedExpression) {
        this.onChoose(expr);
    }
}

// Batch apply multiple saved expressions
class BatchApplyModal extends Modal {
    plugin: RegexFindReplacePlugin;
    editor: Editor;
    selected: Record<string, boolean> = {};

    constructor(app: App, plugin: RegexFindReplacePlugin, editor: Editor) {
        super(app);
        this.plugin = plugin;
        this.editor = editor;
    }

    onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText('批量运行表达式');
        if (this.plugin.settings.savedExpressions.length === 0) {
            contentEl.setText('No saved expressions available. Create some in Settings.');
            return;
        }

        this.plugin.settings.savedExpressions.forEach(expr => {
            const row = contentEl.createDiv({ cls: 'row' });
            const labelEl = row.createDiv({ cls: 'check-label' });
            labelEl.setText(expr.name);
            const targetEl = row.createDiv({ cls: 'row' });
            const toggle = new ToggleComponent(targetEl);
            toggle.setTooltip(`${expr.pattern} -> ${expr.replace}`);
            toggle.onChange(v => { this.selected[expr.name] = v; });
        });

        const btnRow = contentEl.createDiv({ cls: 'row button-wrapper' });
        const runBtn = new ButtonComponent(btnRow);
        runBtn.setCta();
        runBtn.setButtonText('Run');
        runBtn.onClick(() => {
            const names = Object.keys(this.selected).filter(n => this.selected[n]);
            const exprs = this.plugin.settings.savedExpressions.filter(e => names.includes(e.name));
            this.plugin.applyBatch(this.editor, exprs);
            this.close();
        });

        const savePresetBtn = new ButtonComponent(btnRow);
        savePresetBtn.setButtonText('保存为预设');
        savePresetBtn.onClick(() => {
            const names = Object.keys(this.selected).filter(n => this.selected[n]);
            new SaveGroupModal(this.app, this.plugin, { name: '', items: names }).open();
        });

        const cancelBtn = new ButtonComponent(btnRow);
        cancelBtn.setButtonText('Cancel');
        cancelBtn.onClick(() => this.close());
    }

    onClose() { this.contentEl.empty(); }
}

// Modal to save or edit a group preset
class SaveGroupModal extends Modal {
    plugin: RegexFindReplacePlugin;
    group: ExpressionGroup;
    onSaved?: () => void;

    constructor(app: App, plugin: RegexFindReplacePlugin, preset?: ExpressionGroup, onSaved?: () => void) {
        super(app);
        this.plugin = plugin;
        this.group = preset ?? { name: '', items: [] };
        this.onSaved = onSaved;
    }

    onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText('保存预设');

        const nameRow = contentEl.createDiv({ cls: 'row' });
        nameRow.createDiv({ cls: 'input-label' }).setText('名称:');
        const nameWrap = nameRow.createDiv({ cls: 'input-wrapper' });
        const nameInput = new TextComponent(nameWrap);
        nameInput.setPlaceholder('例如：文档清理');
        nameInput.setValue(this.group.name || '');

        contentEl.createEl('div', { cls: 'row' }).createEl('div', { cls: 'input-label', text: '选择表达式：' });
        const selected: Record<string, boolean> = {};
        this.plugin.settings.savedExpressions.forEach(expr => {
            const row = contentEl.createDiv({ cls: 'row' });
            const labelEl = row.createDiv({ cls: 'check-label' });
            labelEl.setText(expr.name);
            const targetEl = row.createDiv({ cls: 'row' });
            const toggle = new ToggleComponent(targetEl);
            const pre = this.group.items?.includes(expr.name) ?? false;
            toggle.setValue(pre);
            selected[expr.name] = pre;
            toggle.onChange(v => { selected[expr.name] = v; });
        });

        const btnRow = contentEl.createDiv({ cls: 'row button-wrapper' });
        const saveBtn = new ButtonComponent(btnRow);
        saveBtn.setCta();
        saveBtn.setButtonText('保存');
        saveBtn.onClick(() => {
            const name = nameInput.getValue().trim();
            if (!name) { new Notice('名称必填'); return; }
            const items = Object.keys(selected).filter(n => selected[n]);
            if (!items.length) { new Notice('请至少选择一个表达式'); return; }
            this.plugin.saveOrUpdateGroup({ name, items });
            this.close();
            if (this.onSaved) this.onSaved();
        });

        const cancelBtn = new ButtonComponent(btnRow);
        cancelBtn.setButtonText('取消');
        cancelBtn.onClick(() => this.close());
    }

    onClose() { this.contentEl.empty(); }
}

// Suggest modal to pick a saved group preset
class RunSavedGroupSuggest extends SuggestModal<ExpressionGroup> {
    plugin: RegexFindReplacePlugin;
    onChoose: (group: ExpressionGroup) => void;

    constructor(app: App, plugin: RegexFindReplacePlugin, onChoose: (group: ExpressionGroup) => void) {
        super(app);
        this.plugin = plugin;
        this.onChoose = onChoose;
        this.setPlaceholder('搜索预设...');
    }

    getSuggestions(query: string): ExpressionGroup[] {
        const q = query.toLowerCase();
        return this.plugin.settings.savedGroups.filter(g => g.name.toLowerCase().includes(q));
    }

    renderSuggestion(group: ExpressionGroup, el: HTMLElement) {
        el.createEl('div', { text: group.name });
        el.createEl('small', { text: `Items: ${group.items.join(', ')}` });
    }

    onChooseSuggestion(group: ExpressionGroup) {
        this.onChoose(group);
    }
}