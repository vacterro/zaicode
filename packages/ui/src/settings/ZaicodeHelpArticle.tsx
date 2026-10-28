import type { HelpArticle } from "./zaicodeHelpWiki.js";

/**
 * One encyclopedia article under its Help card (SRC-060): why it exists, how
 * to use it step by step, every control and word on it, and what to do when
 * something does not behave.
 */
export function ZaicodeHelpArticle({ article }: { article: HelpArticle }) {
  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-border/60 pt-2" data-zaicode-help-article>
      <p className="max-w-[760px] text-foreground">{article.why}</p>
      {article.steps && article.steps.length > 0 ? (
        <div>
          <h4 className="font-medium text-foreground">How to use it</h4>
          <ol className="flex flex-col gap-0.5 pl-4">
            {article.steps.map((step) => (
              <li key={step} className="list-decimal text-foreground">
                {step}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {article.terms && article.terms.length > 0 ? (
        <div>
          <h4 className="font-medium text-foreground">Everything on it, one by one</h4>
          <dl className="grid grid-cols-[minmax(8rem,max-content)_1fr] gap-x-3 gap-y-0.5">
            {article.terms.map(([term, meaning]) => (
              <div key={term} className="contents">
                <dt className="font-medium text-foreground">{term}</dt>
                <dd className="text-foreground-subtle">{meaning}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
      {article.problems && article.problems.length > 0 ? (
        <div>
          <h4 className="font-medium text-foreground">If something looks wrong</h4>
          <ul className="flex flex-col gap-0.5 pl-4">
            {article.problems.map(([symptom, fix]) => (
              <li key={symptom} className="list-disc text-foreground">
                <span className="font-medium">{symptom}</span> — <span className="text-foreground-subtle">{fix}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {article.tips && article.tips.length > 0 ? (
        <ul className="flex flex-col gap-0.5 pl-4 text-foreground-subtle">
          {article.tips.map((tip) => (
            <li key={tip} className="list-['💡_']">
              {tip}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** All of an article's words, for Help's search box. */
export function zaicodeHelpArticleText(article: HelpArticle | undefined): string[] {
  if (!article) return [];
  return [
    article.why,
    ...(article.steps ?? []),
    ...(article.terms ?? []).flat(),
    ...(article.problems ?? []).flat(),
    ...(article.tips ?? []),
  ];
}
