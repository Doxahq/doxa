import { ApiMethodBadge } from "@/src/components/markdown/api-method-badge";

export function ArticleTitle({
  title,
  apiMethod,
}: {
  title: string;
  apiMethod?: string;
}) {
  return (
    <h1 className="flex min-w-0 items-center gap-3 text-3xl font-bold tracking-tight lg:text-4xl">
      {apiMethod ? (
        <>
          <ApiMethodBadge method={apiMethod} />
          <span>{title}</span>
        </>
      ) : (
        title
      )}
    </h1>
  );
}
