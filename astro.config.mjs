// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeMermaid from 'rehype-mermaid';

// GitHub Pages deploy: https://igor53627.github.io/2d-docs/
export default defineConfig({
	site: 'https://igor53627.github.io',
	base: '/2d-docs',
	markdown: {
		syntaxHighlight: { excludeLangs: ['mermaid'] },
		rehypePlugins: [[rehypeMermaid, { strategy: 'inline-svg' }]],
	},
	integrations: [
		starlight({
			title: '2D docs',
			description:
				'Documentation for the 2D chain: a Tron- and Ethereum-compatible L1 with a USD-stable base asset, instant finality, and gasless transactions.',
			defaultLocale: 'root',
			locales: {
				root: {
					label: 'English',
					lang: 'en',
				},
				ru: {
					label: 'Русский',
					lang: 'ru',
				},
			},
			social: [
				{
					icon: 'github',
					label: 'Source',
					href: 'https://github.com/igor53627/2d',
				},
			],
			editLink: {
				baseUrl: 'https://github.com/igor53627/2d-docs/edit/main/',
			},
			sidebar: [
				{
					label: 'Architecture',
					translations: {
						ru: 'Архитектура',
					},
					items: [
						{
							label: 'Tron & Ethereum addresses',
							translations: {
								ru: 'Адреса Tron и Ethereum',
							},
							slug: 'architecture/addresses',
						},
						{
							label: 'Precompiles (no EVM)',
							translations: {
								ru: 'Precompile-ы (без EVM)',
							},
							slug: 'architecture/precompiles',
						},
						{
							label: 'State roots (no validators)',
							translations: {
								ru: 'State roots (без валидаторов)',
							},
							slug: 'architecture/state-roots',
						},
						{
							label: 'Gasless transactions',
							translations: {
								ru: 'Бесплатные транзакции',
							},
							slug: 'architecture/gasless',
						},
						{
							label: 'Security model',
							translations: {
								ru: 'Модель безопасности',
							},
							slug: 'architecture/security',
						},
						{
							label: 'Bridge (HTLC + atomic bridge-lock)',
							translations: {
								ru: 'Мост (HTLC + атомарный bridge-lock)',
							},
							slug: 'architecture/bridge',
						},
						{
							label: 'Bridge operator HSM topology',
							translations: {
								ru: 'HSM-топология оператора моста',
							},
							slug: 'architecture/hsm-topology',
						},
						{
							label: 'Running a verifier',
							translations: {
								ru: 'Запуск верификатора',
							},
							slug: 'architecture/verifier',
						},
					],
				},
			],
		}),
	],
});
