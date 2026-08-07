/**
 * Cross-collection duplicate dialog.
 *
 * One screen: pick a target collection, then map the target's fields to
 * source fields. Target fields are the rows so "every required field has a
 * source" is readable at a glance. Everything the copy will drop is named
 * below the table rather than left for the user to discover afterwards.
 */

import { Button, Checkbox, Dialog, Loader, Select } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";

import {
	duplicateContentTo,
	fetchDuplicateMapping,
	type DuplicateFieldMapping,
	type DuplicateToResult,
} from "../lib/api";
import { DialogError, getMutationError } from "./DialogError.js";

export interface DuplicateToDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Source collection slug. */
	collection: string;
	/** Entries to copy. */
	ids: string[];
	/** Collections that can be targeted, excluding the source. */
	targets: Array<{ slug: string; label: string }>;
	/** Called once the run settles, with the results in request order. */
	onComplete: (results: DuplicateToResult[]) => void;
}

export function DuplicateToDialog({
	open,
	onOpenChange,
	collection,
	ids,
	targets,
	onComplete,
}: DuplicateToDialogProps) {
	const { t } = useLingui();
	const [target, setTarget] = React.useState("");
	const [mapping, setMapping] = React.useState<DuplicateFieldMapping>({});
	const [saveMapping, setSaveMapping] = React.useState(false);
	const [trashSource, setTrashSource] = React.useState(false);

	// Each run starts from a clean slate: `trashSource` is deliberately never
	// persisted, and the mapping is re-resolved for the chosen pair.
	React.useEffect(() => {
		if (!open) return;
		setTarget("");
		setMapping({});
		setSaveMapping(false);
		setTrashSource(false);
	}, [open]);

	const {
		data: resolved,
		isLoading,
		error: mappingError,
	} = useQuery({
		queryKey: ["duplicate-mapping", collection, target, ids],
		queryFn: () => fetchDuplicateMapping(collection, target, ids),
		enabled: open && target !== "",
	});

	React.useEffect(() => {
		if (resolved) setMapping(resolved.mapping);
	}, [resolved]);

	const duplicateMutation = useMutation({
		mutationFn: () =>
			duplicateContentTo(collection, {
				ids,
				targetCollection: target,
				mapping,
				saveMapping,
				trashSource,
			}),
		onSuccess: (results) => {
			onComplete(results);
			onOpenChange(false);
		},
	});

	const targetFields = resolved?.targetCollection.fields ?? [];
	const sourceFields = resolved?.sourceCollection.fields ?? [];
	const sourceLabels = new Map(sourceFields.map((field) => [field.slug, field.label]));

	const missingRequired = targetFields
		.filter((field) => field.required && !mapping[field.slug])
		.map((field) => field.slug);
	const unmappable = resolved?.unmappableRequired ?? [];
	const mappedSources = new Set(Object.values(mapping).filter((slug): slug is string => !!slug));
	const droppedSourceFields = sourceFields.filter((field) => !mappedSources.has(field.slug));
	const droppedTaxonomies = resolved?.taxonomies.dropped ?? [];
	const inboundEdges = resolved?.referenceEdges?.inbound ?? 0;
	const outboundEdges = resolved?.referenceEdges?.outbound ?? 0;
	const seoDropped = resolved ? resolved.seo.sourceEnabled && !resolved.seo.targetEnabled : false;

	const canConfirm =
		!!resolved &&
		unmappable.length === 0 &&
		missingRequired.length === 0 &&
		!duplicateMutation.isPending;

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange} disablePointerDismissal>
			<Dialog className="flex max-h-[85vh] flex-col p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">{t`Duplicate to another collection`}</Dialog.Title>
				<Dialog.Description className="text-kumo-subtle">
					{plural(ids.length, {
						one: "Copy # entry into another collection.",
						other: "Copy # entries into another collection.",
					})}
				</Dialog.Description>

				<div className="mt-4 flex-1 space-y-4 overflow-y-auto">
					<div className="max-w-sm">
						<label
							htmlFor="duplicate-to-target"
							className="mb-1 block text-sm font-medium"
						>{t`Target collection`}</label>
						<Select
							id="duplicate-to-target"
							aria-label={t`Target collection`}
							value={target}
							onValueChange={(value) => setTarget(value ?? "")}
							items={{
								"": t`Select a collection…`,
								...Object.fromEntries(targets.map((c) => [c.slug, c.label])),
							}}
						>
							<Select.Option value="">{t`Select a collection…`}</Select.Option>
							{targets.map((c) => (
								<Select.Option key={c.slug} value={c.slug}>
									{c.label}
								</Select.Option>
							))}
						</Select>
					</div>

					{isLoading && (
						<div className="flex justify-center py-8">
							<Loader />
						</div>
					)}

					<DialogError message={getMutationError(mappingError)} />
					<DialogError message={getMutationError(duplicateMutation.error)} />

					{resolved && unmappable.length > 0 && (
						<DialogError
							message={t`These collections can't be mapped: ${unmappable.join(", ")} is required in ${resolved.targetCollection.label} but no source field has a matching type.`}
						/>
					)}

					{resolved && unmappable.length === 0 && (
						<>
							<div className="overflow-x-auto rounded-md border">
								<table className="w-full text-sm">
									<thead>
										<tr className="border-b bg-kumo-tint/50">
											<th
												scope="col"
												className="px-4 py-2 text-start font-medium"
											>{t`${resolved.targetCollection.label} field`}</th>
											<th
												scope="col"
												className="px-4 py-2 text-start font-medium"
											>{t`Copied from`}</th>
										</tr>
									</thead>
									<tbody>
										{targetFields.map((field) => {
											const value = mapping[field.slug] ?? "";
											const isMissing = field.required && !value;
											return (
												<tr key={field.slug} className="border-b last:border-b-0">
													<td className="px-4 py-2">
														<span className="font-medium">{field.label}</span>
														{field.required && (
															<span className="ms-1 text-kumo-danger" aria-hidden="true">
																*
															</span>
														)}
														{isMissing && (
															<p className="text-xs text-kumo-danger">{t`Required — pick a source field`}</p>
														)}
													</td>
													<td className="px-4 py-2">
														<Select
															size="sm"
															aria-label={t`Source field for ${field.label}`}
															value={value}
															onValueChange={(next) =>
																setMapping((prev) => ({
																	...prev,
																	[field.slug]: next ? next : null,
																}))
															}
															items={{
																"": t`Not copied`,
																...Object.fromEntries(
																	field.compatibleSources.map((slug) => [
																		slug,
																		sourceLabels.get(slug) ?? slug,
																	]),
																),
															}}
														>
															<Select.Option value="">{t`Not copied`}</Select.Option>
															{field.compatibleSources.map((slug) => (
																<Select.Option key={slug} value={slug}>
																	{sourceLabels.get(slug) ?? slug}
																</Select.Option>
															))}
														</Select>
													</td>
												</tr>
											);
										})}
									</tbody>
								</table>
							</div>

							<section className="rounded-md border border-dashed p-4">
								<h3 className="text-sm font-medium">{t`Won't be copied`}</h3>
								<ul className="mt-2 space-y-1 text-sm text-kumo-subtle">
									{droppedSourceFields.length > 0 && (
										<li>{t`Fields: ${droppedSourceFields.map((f) => f.label).join(", ")}`}</li>
									)}
									{droppedTaxonomies.length > 0 && (
										<li>
											{t`Taxonomies not attached to ${resolved.targetCollection.label}: ${droppedTaxonomies.map((tx) => tx.label).join(", ")}`}
										</li>
									)}
									{seoDropped && (
										<li>{t`SEO metadata — the target collection has SEO disabled`}</li>
									)}
									{outboundEdges > 0 && (
										<li>
											{plural(outboundEdges, {
												one: "# reference this entry makes — relations belong to a collection",
												other: "# references these entries make — relations belong to a collection",
											})}
										</li>
									)}
									{inboundEdges > 0 && (
										<li>
											{plural(inboundEdges, {
												one: "# item links to this — that link will keep pointing at the original",
												other:
													"# items link to these — those links will keep pointing at the originals",
											})}
										</li>
									)}
									{droppedSourceFields.length === 0 &&
										droppedTaxonomies.length === 0 &&
										!seoDropped &&
										outboundEdges === 0 &&
										inboundEdges === 0 && <li>{t`Nothing — everything carries over.`}</li>}
								</ul>
							</section>
						</>
					)}
				</div>

				{/* Outside the scroll area: the trash option changes what the run
				    does, so it must never be hidden below the fold. */}
				{resolved && unmappable.length === 0 && (
					<div className="mt-4 flex flex-col items-start gap-2 border-t pt-4">
						<Checkbox
							checked={saveMapping}
							onCheckedChange={(checked) => setSaveMapping(checked)}
							label={t`Remember this mapping for ${resolved.targetCollection.label}`}
						/>
						<Checkbox
							checked={trashSource}
							onCheckedChange={(checked) => setTrashSource(checked)}
							label={plural(ids.length, {
								one: "Move the original to trash after copying",
								other: "Move the originals to trash after copying",
							})}
						/>
					</div>
				)}

				<div className="mt-6 flex justify-end gap-2">
					<Dialog.Close
						render={(p) => (
							<Button {...p} variant="secondary">
								{t`Cancel`}
							</Button>
						)}
					/>
					<Button
						disabled={!canConfirm}
						loading={duplicateMutation.isPending}
						onClick={() => duplicateMutation.mutate()}
					>
						{t`Duplicate`}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
