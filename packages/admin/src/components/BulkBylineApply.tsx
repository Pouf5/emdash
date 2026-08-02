import { Badge, Button, Checkbox, Input, Popover } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { CaretDown } from "@phosphor-icons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import * as React from "react";

import { fetchBylines } from "../lib/api";
import { useDebouncedValue } from "../lib/hooks.js";

/** Matches the server's cap on credits per entry. */
const MAX_SELECTED = 25;

interface BulkBylineApplyProps {
	/** How many entries the credits will be set on. */
	count: number;
	disabled?: boolean;
	/** Locale the list is showing, so the picker offers matching byline rows. */
	locale?: string;
	/** Receives the chosen byline row ids (not translation groups). */
	onApply: (bylineIds: string[]) => void;
}

/**
 * Bulk byline picker for the content list's selection toolbar. The picked
 * bylines become each selected entry's whole credit set — an entry's existing
 * credits are replaced, not merged into.
 */
export function BulkBylineApply({ count, disabled, locale, onApply }: BulkBylineApplyProps) {
	const { t } = useLingui();
	const [open, setOpen] = React.useState(false);
	const [search, setSearch] = React.useState("");
	const [selected, setSelected] = React.useState<string[]>([]);
	const debouncedSearch = useDebouncedValue(search, 300);
	const trimmedSearch = debouncedSearch.trim();

	const { data, isLoading } = useQuery({
		queryKey: ["bylines", "bulk-apply", locale ?? null, trimmedSearch],
		queryFn: () => fetchBylines({ search: trimmedSearch || undefined, locale, limit: 20 }),
		enabled: open,
		placeholderData: keepPreviousData,
	});

	const options = data?.items ?? [];
	const atLimit = selected.length >= MAX_SELECTED;

	const toggle = (id: string) => {
		setSelected((prev) => {
			if (prev.includes(id)) return prev.filter((value) => value !== id);
			if (prev.length >= MAX_SELECTED) return prev;
			return [...prev, id];
		});
	};

	const apply = () => {
		if (selected.length === 0) return;
		onApply(selected);
		setSelected([]);
		setSearch("");
		setOpen(false);
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<Button size="sm" variant="secondary" disabled={disabled} className="gap-2">
					{t`Set byline`}
					<CaretDown className="h-4 w-4 shrink-0" aria-hidden="true" />
				</Button>
			</Popover.Trigger>

			<Popover.Content className="w-72 p-2" align="start">
				<Input
					size="sm"
					type="search"
					aria-label={t`Search bylines`}
					placeholder={t`Search bylines…`}
					value={search}
					onChange={(e) => setSearch(e.target.value)}
				/>

				<div className="mt-2 max-h-64 overflow-y-auto" role="group" aria-label={t`Bylines`}>
					{isLoading && <p className="p-2 text-sm text-kumo-subtle">{t`Loading…`}</p>}

					{!isLoading && options.length === 0 && (
						<p className="p-2 text-sm text-kumo-subtle">{t`No bylines found`}</p>
					)}

					{options.map((byline) => {
						const checked = selected.includes(byline.id);
						return (
							<div key={byline.id} className="rounded px-2 py-1 hover:bg-kumo-tint/50">
								<Checkbox
									checked={checked}
									disabled={!checked && atLimit}
									onCheckedChange={() => toggle(byline.id)}
									label={<span className="text-sm">{byline.displayName}</span>}
								/>
							</div>
						);
					})}

					{data?.nextCursor && (
						<p className="p-2 text-sm text-kumo-subtle">{t`Search to narrow the list`}</p>
					)}
				</div>

				{atLimit && (
					<Badge className="mt-2" variant="warning">
						{t`Up to ${MAX_SELECTED} bylines can be selected`}
					</Badge>
				)}

				<div className="mt-2 flex items-center justify-between gap-2 border-t pt-2">
					<span className="text-xs text-kumo-subtle">
						{t`Replaces the credits on ${count} entries`}
					</span>
					<Button size="sm" disabled={selected.length === 0} onClick={apply}>
						{t`Apply`}
					</Button>
				</div>
			</Popover.Content>
		</Popover>
	);
}
