// Pure locale/slug utilities — no astro:content dependency
// Safe to import from both server and client-side code

export function getLocaleFromSlug(slug: string): string {
	const parts = slug.split("/");
	if (parts.length > 1 && (parts[0] === "en" || parts[0] === "ko")) {
		return parts[0];
	}
	return "en";
}

export function getSlugWithoutLocale(slug: string): string {
	const parts = slug.split("/");
	if (parts.length > 1 && (parts[0] === "en" || parts[0] === "ko")) {
		return parts.slice(1).join("/");
	}
	return slug;
}
