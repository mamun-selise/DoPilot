using Microsoft.AspNetCore.StaticFiles;

/// <summary>Content types and cache rules for the web app's files and the KORA CLI tarballs.</summary>
public static class StaticFiles
{
    /// <summary>Shared by UseStaticFiles and the index.html fallback, so every route gets the same headers.</summary>
    public static StaticFileOptions Options => new()
    {
        ContentTypeProvider = CreateContentTypes(),
        ServeUnknownFileTypes = true, // dist/env.<environment> from write-release-env.mjs
        DefaultContentType = "text/plain",
        OnPrepareResponse = context =>
        {
            if (context.File.Name == "index.html") context.Context.Response.Headers.CacheControl = "no-cache";
            else SetCacheHeaders(context.Context.Request.Path, context.Context.Response);
        }
    };

    // no-cache makes npm revalidate the latest tarball instead of reusing a stale cached copy, and makes browsers
    // pick up a new index.html after a deploy; versioned tarballs and hashed assets never change.
    public static void SetCacheHeaders(PathString path, HttpResponse response)
    {
        var value = path.Value ?? "";
        if (value is "/kora" or "/kora.tgz" or "/kora.json")
            response.Headers.CacheControl = "no-cache";
        else if (value.StartsWith("/kora-", StringComparison.Ordinal) || value.StartsWith("/assets/", StringComparison.Ordinal))
            response.Headers.CacheControl = "public, max-age=31536000, immutable";
    }

    private static FileExtensionContentTypeProvider CreateContentTypes()
    {
        var provider = new FileExtensionContentTypeProvider();
        provider.Mappings[".tgz"] = "application/gzip";
        return provider;
    }
}
