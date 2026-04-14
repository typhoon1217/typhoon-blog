import { type CollectionEntry, getCollection } from "astro:content";
import I18nKey from "@i18n/i18nKey";
import { i18n } from "@i18n/translation";
import { getCategoryUrl } from "@utils/url-utils.ts";

import { getLocaleFromSlug, getSlugWithoutLocale } from "@utils/locale-utils";
export { getLocaleFromSlug, getSlugWithoutLocale };

async function getRawSortedPosts() {
	const allBlogPosts = await getCollection("posts", ({ data }) => {
		return import.meta.env.PROD ? data.draft !== true : true;
	});

	const sorted = allBlogPosts.sort((a, b) => {
		const dateA = new Date(a.data.published);
		const dateB = new Date(b.data.published);
		return dateA > dateB ? -1 : 1;
	});
	return sorted;
}

export async function getSortedPosts() {
	const sorted = await getRawSortedPosts();

	for (let i = 1; i < sorted.length; i++) {
		sorted[i].data.nextSlug = sorted[i - 1].slug;
		sorted[i].data.nextTitle = sorted[i - 1].data.title;
	}
	for (let i = 0; i < sorted.length - 1; i++) {
		sorted[i].data.prevSlug = sorted[i + 1].slug;
		sorted[i].data.prevTitle = sorted[i + 1].data.title;
	}

	return sorted;
}

// Returns posts filtered by locale, with prev/next set within same locale
export async function getSortedPostsByLocale(locale: string) {
	const allSorted = await getRawSortedPosts();
	const filtered = allSorted.filter((p) => getLocaleFromSlug(p.slug) === locale);

	for (let i = 1; i < filtered.length; i++) {
		filtered[i].data.nextSlug = filtered[i - 1].slug;
		filtered[i].data.nextTitle = filtered[i - 1].data.title;
	}
	for (let i = 0; i < filtered.length - 1; i++) {
		filtered[i].data.prevSlug = filtered[i + 1].slug;
		filtered[i].data.prevTitle = filtered[i + 1].data.title;
	}

	return filtered;
}

export type PostForList = {
	slug: string;
	data: CollectionEntry<"posts">["data"];
};

export async function getSortedPostsList(): Promise<PostForList[]> {
	const sortedFullPosts = await getRawSortedPosts();
	return sortedFullPosts.map((post) => ({
		slug: post.slug,
		data: post.data,
	}));
}

export async function getSortedPostsListByLocale(locale: string): Promise<PostForList[]> {
	const posts = await getSortedPostsByLocale(locale);
	return posts.map((post) => ({
		slug: post.slug,
		data: post.data,
	}));
}

export type Tag = { name: string; count: number };

export async function getTagList(): Promise<Tag[]> {
	const allBlogPosts = await getCollection<"posts">("posts", ({ data }) => {
		return import.meta.env.PROD ? data.draft !== true : true;
	});
	const countMap: { [key: string]: number } = {};
	allBlogPosts.forEach((post) => {
		post.data.tags.forEach((tag) => {
			if (!countMap[tag]) countMap[tag] = 0;
			countMap[tag]++;
		});
	});
	const keys = Object.keys(countMap).sort((a, b) =>
		a.toLowerCase().localeCompare(b.toLowerCase()),
	);
	return keys.map((key) => ({ name: key, count: countMap[key] }));
}

export async function getTagListByLocale(locale: string): Promise<Tag[]> {
	const posts = await getSortedPostsByLocale(locale);
	const countMap: { [key: string]: number } = {};
	posts.forEach((post) => {
		post.data.tags.forEach((tag) => {
			if (!countMap[tag]) countMap[tag] = 0;
			countMap[tag]++;
		});
	});
	const keys = Object.keys(countMap).sort((a, b) =>
		a.toLowerCase().localeCompare(b.toLowerCase()),
	);
	return keys.map((key) => ({ name: key, count: countMap[key] }));
}

export type Category = { name: string; count: number; url: string };

export async function getCategoryList(): Promise<Category[]> {
	const allBlogPosts = await getCollection<"posts">("posts", ({ data }) => {
		return import.meta.env.PROD ? data.draft !== true : true;
	});
	return buildCategoryList(allBlogPosts);
}

export async function getCategoryListByLocale(locale: string): Promise<Category[]> {
	const posts = await getSortedPostsByLocale(locale);
	return buildCategoryList(posts);
}

function buildCategoryList(posts: CollectionEntry<"posts">[]): Category[] {
	const count: { [key: string]: number } = {};
	posts.forEach((post) => {
		if (!post.data.category) {
			const ucKey = i18n(I18nKey.uncategorized);
			count[ucKey] = count[ucKey] ? count[ucKey] + 1 : 1;
			return;
		}
		const categoryName =
			typeof post.data.category === "string"
				? post.data.category.trim()
				: String(post.data.category).trim();
		count[categoryName] = count[categoryName] ? count[categoryName] + 1 : 1;
	});

	return Object.keys(count)
		.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
		.map((c) => ({ name: c, count: count[c], url: getCategoryUrl(c) }));
}
