
function do_migrate -a pod
    if test -z "$pod"
        echo "pod required"
        return 1
    end
    deno run --allow-run=kubectl --allow-write=./logs main.ts migrate "$pod" | tee log-"$pod".txt
end
