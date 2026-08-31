import type { ThinkingLevel } from "@smolt/agent-core";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	matchesKey,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	Spacer,
	Text,
} from "@smolt/tui";
import type { ThinkingLevelSelectorEntry } from "../../../core/extensions/types.ts";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText } from "./keybinding-hints.ts";

const THINKING_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

const LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Extra-high reasoning (~32k tokens)",
	max: "Maximum reasoning",
};

/**
 * Component that renders a thinking level selector with borders
 */
export class ThinkingSelectorComponent extends Container implements Focusable {
	private searchInput: Input;
	private selectList: SelectList;
	private selectListChildIndex: number;
	private allItems: SelectItem[];
	private onSelect: (value: string) => void;
	private onCancel: () => void;
	private onSelectAsDefault?: (value: string) => void;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		currentValue: string,
		availableLevels: ThinkingLevel[],
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectAsDefault?: (value: string) => void,
		defaultThinkingLevel?: ThinkingLevel,
		entries: ThinkingLevelSelectorEntry[] = [],
	) {
		super();
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.onSelectAsDefault = onSelectAsDefault;

		// Extension entries render first (far left), then the model's levels.
		this.allItems = [
			...entries.map((entry) => ({
				value: entry.value,
				label: entry.label,
				description: entry.description,
			})),
			...availableLevels.map((level) => ({
				value: level,
				label: level,
				description:
					level === defaultThinkingLevel ? `${LEVEL_DESCRIPTIONS[level]} · default` : LEVEL_DESCRIPTIONS[level],
			})),
		];

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text("Thinking Level", 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(`${keyDisplayText("app.thinking.cycle")} cycles thinking levels in-session`, 0, 0));
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		this.searchInput.onSubmit = () => this.selectList.handleInput("\r");
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		// Create selector
		this.selectList = this.buildSelectList(this.allItems, currentValue);
		this.selectListChildIndex = this.children.length;
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select · Ctrl+S to set as default · Esc to cancel"), 0, 0));

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	private buildSelectList(items: SelectItem[], preselect?: string): SelectList {
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), THINKING_SELECT_LIST_LAYOUT);
		const currentIndex = items.findIndex((item) => item.value === preselect);
		if (currentIndex !== -1) {
			list.setSelectedIndex(currentIndex);
		}
		list.onSelect = (item) => this.onSelect(item.value);
		list.onCancel = () => this.onCancel();
		return list;
	}

	private applyFilter(query: string): void {
		const filtered = query
			? fuzzyFilter(this.allItems, query, (item) => `${item.label} ${item.description ?? ""}`)
			: this.allItems;
		const selectedValue = this.selectList.getSelectedItem()?.value;
		const newList = this.buildSelectList(filtered, selectedValue);
		this.children[this.selectListChildIndex] = newList;
		this.selectList = newList;
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "ctrl+s") && this.onSelectAsDefault) {
			const item = this.selectList.getSelectedItem();
			if (item) this.onSelectAsDefault(item.value);
			return;
		}

		const kb = getKeybindings();
		const isNav =
			kb.matches(keyData, "tui.select.up") ||
			kb.matches(keyData, "tui.select.down") ||
			kb.matches(keyData, "tui.select.confirm") ||
			kb.matches(keyData, "tui.select.cancel");
		if (isNav) {
			this.selectList.handleInput(keyData);
			return;
		}

		this.searchInput.handleInput(keyData);
		this.applyFilter(this.searchInput.getValue());
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
