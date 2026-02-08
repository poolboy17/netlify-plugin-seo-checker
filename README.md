# netlify-plugin-seo-checker

A Netlify Build Plugin that scans your built HTML for SEO issues on every deploy.

## What it checks

- **Missing `<title>` tags** — error
- **Missing meta descriptions** — error
- **Missing image alt attributes** — error
- **Broken internal links** — error (links to pages that don't exist in the build)
- **Orphan pages** — warning (content pages with no inbound internal links)
- **Thin content** — warning (pages below minimum word count)
- **Missing canonical tags** — warning
- **Missing Open Graph tags** — warning (og:title, og:description, og:image)
- **Duplicate titles/descriptions** — warning
- **Title/description length** — warning (title >60 chars, description >155 chars)

## Installation

### Option A: Local plugin (recommended for private projects)

1. Copy the `plugins/seo-checker` folder into your project
2. Add to `netlify.toml`:

```toml
[[plugins]]
  package = "./plugins/seo-checker"

  [plugins.inputs]
    minWordCount = 300
    failOnError = false
```

### Option B: From a git repo

Push this plugin to its own GitHub repo, then reference it:

```toml
[[plugins]]
  package = "https://github.com/YOUR_USER/netlify-plugin-seo-checker"

  [plugins.inputs]
    minWordCount = 300
    failOnError = false
```

## Configuration

| Input | Default | Description |
|-------|---------|-------------|
| `minWordCount` | 300 | Minimum word count for content pages before flagging as thin |
| `failOnError` | false | Set to `true` to fail the build when errors are found |

## Output

The plugin prints a full report to the deploy log including an error/warning list and a page-by-page summary with word counts and status indicators.
